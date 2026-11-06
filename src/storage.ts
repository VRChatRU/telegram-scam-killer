import { Database } from 'bun:sqlite'

export type Report = {
    chatId: number
    userId: number
    messageId: number | null
    chatTitle: string
    name: string
    text: string
}

export type Status = 'pending' | 'banned' | 'kicked' | 'cleared' | 'scam'
export type Outcome = 'delation' | 'automatic' | 'unban' | 'pardon'
type CaseRow = Report & { id: number; status: Status; revision: number }
export type Case = CaseRow & { outcome: Outcome | null }

type Check = Report & { messageId: number }
type QueuedCheck = Check & { attempts: number; forceScam: boolean }
type Alert = { report: Case; adminId: number; messageId: number | null; attempts: number }
type AlertRow = Case & { adminId: number; alertMessageId: number | null; attempts: number }

const reportColumns = 'chat_id AS chatId, user_id AS userId, message_id AS messageId, chat_title AS chatTitle, name, text'
const caseColumns = `id, ${reportColumns}, status, revision`
const caseWithOutcome = `${caseColumns}, CASE
    WHEN case_outcomes.case_id IS NOT NULL THEN case_outcomes.outcome
    WHEN status = 'banned' AND message_id IS NULL THEN 'delation'
END AS outcome`
const caseSource = 'cases LEFT JOIN case_outcomes ON case_outcomes.case_id = cases.id'
const initialCaseRevision = 2

export class Storage {
    private readonly db: Database
    private readonly adminIds: number[]

    constructor(path: string, adminIds: number[]) {
        this.db = new Database(path, { create: true, strict: true })
        this.adminIds = [...new Set(adminIds)]

        try {
            this.db.exec(`
                PRAGMA busy_timeout = 5000;
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS checked_users (id INTEGER PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS scammers (id INTEGER PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS delation_bans (
                    update_id INTEGER NOT NULL,
                    event_date INTEGER NOT NULL,
                    PRIMARY KEY (update_id, event_date)
                ) WITHOUT ROWID;

                CREATE TABLE IF NOT EXISTS cases (
                    id INTEGER PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    message_id INTEGER,
                    chat_title TEXT NOT NULL,
                    name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'banned', 'kicked', 'cleared', 'scam')),
                    revision INTEGER NOT NULL DEFAULT ${initialCaseRevision},
                    UNIQUE (chat_id, user_id)
                );
                CREATE INDEX IF NOT EXISTS cases_user_status ON cases (user_id, status);
                CREATE TABLE IF NOT EXISTS case_outcomes (
                    case_id INTEGER PRIMARY KEY REFERENCES cases (id),
                    outcome TEXT CHECK (outcome IN ('delation', 'automatic', 'unban', 'pardon'))
                );
                CREATE TABLE IF NOT EXISTS case_alert_policies (
                    case_id INTEGER PRIMARY KEY REFERENCES cases (id),
                    release_at INTEGER,
                    suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1))
                );

                CREATE TABLE IF NOT EXISTS checks (
                    chat_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    message_id INTEGER NOT NULL,
                    chat_title TEXT NOT NULL,
                    name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    force_scam INTEGER NOT NULL DEFAULT 0 CHECK (force_scam IN (0, 1)),
                    next_at INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (chat_id, user_id)
                );
                CREATE INDEX IF NOT EXISTS checks_next_at ON checks (next_at);

                CREATE TABLE IF NOT EXISTS alerts (
                    case_id INTEGER NOT NULL REFERENCES cases (id),
                    admin_id INTEGER NOT NULL,
                    alert_message_id INTEGER,
                    applied_revision INTEGER NOT NULL DEFAULT 0,
                    next_at INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (case_id, admin_id)
                );
            `)
            this.db.transaction(() => {
                if (!this.db.query("SELECT 1 FROM pragma_table_info('checks') WHERE name = 'force_scam'").get()) {
                    this.db.exec('ALTER TABLE checks ADD COLUMN force_scam INTEGER NOT NULL DEFAULT 0 CHECK (force_scam IN (0, 1))')
                }
                // Refresh open cards that were sent before they had a pardon button.
                this.db.query("UPDATE cases SET revision = ? WHERE status = 'pending' AND revision < ?")
                    .run(initialCaseRevision, initialCaseRevision)
                this.db.query(`
                    INSERT OR IGNORE INTO case_alert_policies (case_id, suppressed)
                    SELECT id, 1 FROM (SELECT ${caseWithOutcome} FROM ${caseSource}) WHERE outcome = 'delation'
                `).run()
                const addPendingAlerts = this.db.query(`
                    INSERT OR IGNORE INTO alerts (case_id, admin_id) SELECT id, ? FROM cases WHERE status = 'pending'
                `)
                for (const adminId of this.adminIds) addPendingAlerts.run(adminId)
            }).immediate()
        } catch (error) {
            this.db.close()
            throw error
        }
    }

    close() {
        this.db.close()
    }

    getCase(chatId: number, userId: number): Case | null {
        return this.db.query<Case, [number, number]>(`
            SELECT ${caseWithOutcome} FROM ${caseSource} WHERE chat_id = ? AND user_id = ?
        `).get(chatId, userId)
    }

    getCaseById(id: number): Case | null {
        return this.db.query<Case, [number]>(`SELECT ${caseWithOutcome} FROM ${caseSource} WHERE id = ?`).get(id)
    }

    openCase(report: Report, initialStatus: Status = 'pending', outcome: Outcome | null = null, holdAlerts = false): Case {
        return this.db.transaction(() => {
            const existing = this.getCase(report.chatId, report.userId)
            if (existing) return existing

            const opened = this.db.query<CaseRow, [number, number, number | null, string, string, string, Status, number]>(`
                INSERT INTO cases (chat_id, user_id, message_id, chat_title, name, text, status, revision)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING ${caseColumns}
            `).get(report.chatId, report.userId, report.messageId, report.chatTitle, report.name, report.text, initialStatus, initialCaseRevision)!

            const createAlert = this.db.query('INSERT INTO alerts (case_id, admin_id) VALUES (?, ?)')
            for (const adminId of this.adminIds) createAlert.run(opened.id, adminId)
            if (holdAlerts) this.db.query('INSERT INTO case_alert_policies (case_id) VALUES (?)').run(opened.id)
            this.writeOutcome(opened.id, outcome)
            this.recordStatus(opened.userId, opened.status)
            return { ...opened, outcome }
        }).immediate()
    }

    setStatus(id: number, status: Status, outcome: Outcome | null = null): Case {
        return this.db.transaction(() => {
            const current = this.getCaseById(id)
            if (!current) throw new Error(`Moderation case ${id} does not exist`)
            if (current.status === status && current.outcome === outcome) return current

            this.db.query('UPDATE cases SET status = ?, revision = revision + 1 WHERE id = ?').run(status, id)
            this.writeOutcome(id, outcome)
            this.db.query(`
                UPDATE alerts SET next_at = 0, attempts = 0 WHERE case_id = ? AND alert_message_id IS NOT NULL
            `).run(id)
            if (current.status !== status) this.recordStatus(current.userId, status)
            return { ...current, status, outcome, revision: current.revision + 1 }
        }).immediate()
    }

    recordDelationAction(report: Report, eventId: number, eventDate: number, status: 'banned' | 'kicked'): Case | null {
        return this.db.transaction(() => {
            const inserted = this.db.query(`
                INSERT INTO delation_bans (update_id, event_date) VALUES (?, ?)
                ON CONFLICT (update_id, event_date) DO NOTHING
            `).run(eventId, eventDate)
            if (!inserted.changes) return null

            const existing = this.getCase(report.chatId, report.userId)
            const updated = existing ? this.setStatus(existing.id, status, 'delation') : this.openCase(report, status, 'delation')
            this.db.query(`
                INSERT INTO case_alert_policies (case_id, suppressed) VALUES (?, 1)
                ON CONFLICT (case_id) DO UPDATE SET suppressed = 1
            `).run(updated.id)
            return updated
        }).immediate()
    }

    releaseAlerts(caseId: number, nextAt: number) {
        this.db.query(`
            UPDATE case_alert_policies SET release_at = ?
            WHERE case_id = ? AND release_at IS NULL AND suppressed = 0
        `).run(nextAt, caseId)
    }

    isChecked(id: number): boolean {
        return Boolean(this.db.query('SELECT 1 FROM checked_users WHERE id = ?').get(id))
    }

    isScammer(id: number): boolean {
        return Boolean(this.db.query('SELECT 1 FROM scammers WHERE id = ?').get(id))
    }

    markChecked(id: number) {
        this.db.query(`
            INSERT OR IGNORE INTO checked_users (id)
            SELECT ? WHERE NOT EXISTS (SELECT 1 FROM scammers WHERE id = ?)
        `).run(id, id)
    }

    enqueueCheck(report: Check & { forceScam?: boolean }): boolean {
        const forceScam = Number(report.forceScam === true)
        return this.db.query(`
            INSERT INTO checks (chat_id, user_id, message_id, chat_title, name, text, force_scam)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (chat_id, user_id) DO NOTHING
        `).run(report.chatId, report.userId, report.messageId, report.chatTitle, report.name, report.text, forceScam).changes > 0
    }

    nextCheck(now: number, forceScam: boolean): QueuedCheck | null {
        const check = this.db.query<Check & { attempts: number; forceScam: number }, [number, number]>(`
            SELECT ${reportColumns}, attempts, force_scam AS forceScam FROM checks
            WHERE next_at <= ? AND force_scam = ? ORDER BY next_at, rowid LIMIT 1
        `).get(now, Number(forceScam))
        return check && { ...check, forceScam: Boolean(check.forceScam) }
    }

    finishCheck(report: Check) {
        this.db.query('DELETE FROM checks WHERE chat_id = ? AND user_id = ? AND message_id = ?')
            .run(report.chatId, report.userId, report.messageId)
    }

    retryCheck(report: Check, nextAt: number) {
        this.db.query(`
            UPDATE checks SET next_at = ?, attempts = attempts + 1
            WHERE chat_id = ? AND user_id = ? AND message_id = ?
        `).run(nextAt, report.chatId, report.userId, report.messageId)
    }

    nextAlert(now: number): Alert | null {
        if (this.adminIds.length === 0) return null

        const adminPlaceholders = this.adminIds.map(() => '?').join(', ')
        const alert = this.db.query<AlertRow, number[]>(`
            SELECT ${caseWithOutcome}, admin_id AS adminId, alert_message_id AS alertMessageId, attempts
            FROM ${caseSource} JOIN alerts ON alerts.case_id = cases.id
            LEFT JOIN case_alert_policies ON case_alert_policies.case_id = cases.id
            WHERE applied_revision < revision AND next_at <= ? AND admin_id IN (${adminPlaceholders})
                AND (alert_message_id IS NOT NULL OR case_alert_policies.case_id IS NULL
                    OR (case_alert_policies.suppressed = 0 AND case_alert_policies.release_at <= ?))
            ORDER BY alert_message_id IS NULL, next_at, alerts.case_id, admin_id LIMIT 1
        `).get(now, ...this.adminIds, now)
        if (!alert) return null

        const { adminId, alertMessageId, attempts, ...report } = alert
        return { report, adminId, messageId: alertMessageId, attempts }
    }

    markAlert(caseId: number, adminId: number, messageId: number, revision: number) {
        this.db.query(`
            UPDATE alerts SET alert_message_id = ?, applied_revision = ?, next_at = 0, attempts = 0
            WHERE case_id = ? AND admin_id = ?
        `).run(messageId, revision, caseId, adminId)
    }

    getAlertMessageId(caseId: number, adminId: number): number | null {
        return this.db.query<{ messageId: number | null }, [number, number]>(`
            SELECT alert_message_id AS messageId FROM alerts WHERE case_id = ? AND admin_id = ?
        `).get(caseId, adminId)?.messageId ?? null
    }

    clearAlert(caseId: number, adminId: number) {
        this.db.query(`
            UPDATE alerts SET alert_message_id = NULL, applied_revision = 0, next_at = 0, attempts = 0
            WHERE case_id = ? AND admin_id = ?
        `).run(caseId, adminId)
    }

    adoptAlert(caseId: number, adminId: number, messageId: number) {
        this.db.query(`
            INSERT INTO alerts (case_id, admin_id, alert_message_id) VALUES (?, ?, ?)
            ON CONFLICT (case_id, admin_id) DO UPDATE
            SET alert_message_id = excluded.alert_message_id, applied_revision = 0, next_at = 0, attempts = 0
            WHERE alerts.alert_message_id IS NULL
        `).run(caseId, adminId, messageId)
    }

    retryAlert(caseId: number, adminId: number, nextAt: number) {
        this.db.query(`
            UPDATE alerts SET next_at = ?, attempts = attempts + 1 WHERE case_id = ? AND admin_id = ?
        `).run(nextAt, caseId, adminId)
    }

    resetAlerts(adminId: number) {
        this.db.query('UPDATE alerts SET next_at = 0, attempts = 0 WHERE admin_id = ?').run(adminId)
    }

    private writeOutcome(caseId: number, outcome: Outcome | null) {
        this.db.query(`
            INSERT INTO case_outcomes (case_id, outcome) VALUES (?, ?)
            ON CONFLICT (case_id) DO UPDATE SET outcome = excluded.outcome
        `).run(caseId, outcome)
    }

    private recordStatus(userId: number, status: Status) {
        if (status === 'pending') return

        if (status === 'cleared') {
            const active = this.db.query(`
                SELECT 1 FROM cases WHERE user_id = ? AND status IN ('banned', 'kicked', 'scam') LIMIT 1
            `).get(userId)
            if (active) return

            this.db.query('DELETE FROM scammers WHERE id = ?').run(userId)
            this.markChecked(userId)
            return
        }

        this.db.query('DELETE FROM checked_users WHERE id = ?').run(userId)
        this.db.query('INSERT OR IGNORE INTO scammers (id) VALUES (?)').run(userId)
    }
}
