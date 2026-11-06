import { classify, ClassifierError } from './classifier'
import { errorMessage, log, retryDelay, sleep } from './runtime'
import type { Config } from './runtime'
import type { Case, Outcome, Report, Status, Storage } from './storage'
import { ApiError } from './telegram'
import type { CallbackQuery, Chat, ChatMemberUpdated, Keyboard, Message, Telegram, Update, User } from './telegram'

const actionResults = {
    ban: 'Забанен ✅', kick: 'Кикнут ✅', unban: 'Разбанен ✅', pardon: 'Не скаммер ✅', scam: 'Помечен как скаммер ✅',
}
type Action = keyof typeof actionResults
type Check = Report & { messageId: number; attempts: number }

function buttons({ status, outcome }: Case, mode: Config['mode']): [Action, string][] {
    switch (status) {
        case 'pending': return [
            [mode, mode === 'kick' ? 'Кикнуть 💀' : 'Забанить 💀'],
            ['pardon', 'Не скаммер 😅'],
        ]
        case 'banned': {
            if (outcome === 'delation') return [['unban', 'Забанил Delation ✅ Разбанить? 😅']]
            if (outcome === 'automatic') return [['unban', 'Разбанить 😅']]
            return [['unban', 'Забанен ✅ Разбанить? 😅']]
        }
        case 'cleared': {
            if (outcome === 'unban') return [['ban', 'Разбанен ✅ Забанить? 💀']]
            if (outcome === 'pardon') return [['scam', 'Не скаммер ✅ Пометить как скамера? 💀']]
            return [['ban', 'Забанить 💀'], ['scam', 'Пометить как скамера? 💀']]
        }
        case 'kicked': return [['pardon', outcome === 'automatic' ? 'Не скаммер 😅' : 'Кикнут ✅ Не скаммер? 😅']]
        case 'scam': return [['pardon', 'Помечен как скаммер ✅ Отменить? 😅']]
    }
}

function escapeHtml(text: string) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function alertText(report: Case) {
    let { name, chatTitle, text } = report
    const userId = String(report.userId)
    if (name === userId && chatTitle === String(report.chatId)) {
        const oldAlert = text.match(new RegExp(`^⚠️ Скаммер (.*?)${userId} в чате ([^\\n]+)\\n([\\s\\S]*)$`))
        name = oldAlert?.[1].trim() ?? ''
        chatTitle = oldAlert?.[2] ?? chatTitle
        text = oldAlert?.[3] ?? text
    }

    const title = escapeHtml([name, userId].filter(Boolean).join(' '))
    const header = `⚠️ Скаммер <b>${title}</b> в чате <b>${escapeHtml(chatTitle)}</b>`
    const delation = report.outcome === 'delation' ? '\n🚫 Забанил Delation' : ''
    const excerpt = report.messageId !== null && text ? `\n<pre>${escapeHtml([...text].slice(0, 3400).join(''))}</pre>` : ''
    return header + delation + excerpt
}

function isGroup(chat: Chat) {
    return chat.type === 'group' || chat.type === 'supergroup'
}

function reportFor(chat: Chat, user: User, messageId: number | null, text: string): Report {
    return {
        chatId: chat.id,
        chatTitle: chat.title || String(chat.id),
        userId: user.id,
        name: [user.first_name, user.last_name, user.username].filter(Boolean).join(' '),
        messageId,
        text,
    }
}

export function isRetryable(error: unknown) {
    return !(error instanceof ApiError) || error.code === 429 || error.code >= 500
}

function matchesApiError(error: unknown, description: RegExp) {
    return error instanceof ApiError && error.code === 400 && description.test(error.message)
}

export class Moderation {
    private operations = Promise.resolve()

    constructor(
        private readonly config: Config,
        private readonly storage: Storage,
        private readonly telegram: Telegram,
        private readonly signal: AbortSignal,
    ) {}

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operations.then(operation)
        this.operations = result.then(() => {}, () => {})
        return result
    }

    async update(update: Update) {
        const { chat_member, callback_query, message, edited_message, update_id } = update
        if (chat_member) await this.serialize(() => this.onMember(chat_member, update_id))
        if (callback_query) await this.serialize(() => this.onCallback(callback_query))
        if (message) await this.onMessage(message, false)
        if (edited_message) await this.onMessage(edited_message, true)
    }

    private isDelation(user: User | undefined) {
        if (!user?.is_bot) return false
        return this.config.delationId === undefined
            ? user.username?.toLowerCase() === 'delationbot'
            : user.id === this.config.delationId
    }

    private async onMember({ chat, from, date, old_chat_member: old, new_chat_member: current }: ChatMemberUpdated, updateId: number) {
        if (!isGroup(chat) || !this.isDelation(from) || current.user.is_bot) return
        if (old.status === 'kicked' || current.status !== 'kicked') return

        const report = this.storage.recordDelationBan(
            reportFor(chat, current.user, null, ''), updateId, date,
        )
        if (report) log('info', 'delation_ban_recorded', { caseId: report.id, chatId: chat.id, userId: current.user.id })
    }

    private async onMessage(message: Message, edited: boolean) {
        const { chat, from, message_id: messageId } = message
        if (!from || message.sender_chat) return

        if (chat.type === 'private') {
            if (!edited && this.config.adminIds.includes(from.id) && /^\/start(?:@\w+)?(?:\s|$)/.test(message.text ?? '')) {
                this.storage.resetAlerts(from.id)
                try {
                    await this.telegram.call('sendMessage', { chat_id: chat.id, text: 'Уведомления о модерации включены.' })
                } catch (error) {
                    if (isRetryable(error)) throw error
                    log('warn', 'admin_reply_failed', { adminId: from.id, error: errorMessage(error) })
                }
                log('info', 'admin_started', { adminId: from.id })
            }
            return
        }
        if (!isGroup(chat)) return

        const text = message.text ?? message.caption ?? ''
        if (this.isDelation(from) && text.includes('Delation Plus')) {
            await this.deleteMessage(chat.id, messageId, 'delation_plus')
            return
        }
        if (edited || from.is_bot || !text.trim() || this.storage.isChecked(from.id)) return
        if (this.storage.getCase(chat.id, from.id)?.status === 'cleared') return
        if (this.storage.enqueueCheck({ ...reportFor(chat, from, messageId, text), messageId })) {
            log('info', 'check_queued', { chatId: chat.id, messageId, userId: from.id })
        }
    }

    private async deleteMessage(chatId: number, messageId: number, reason: string) {
        try {
            await this.telegram.call('deleteMessage', { chat_id: chatId, message_id: messageId })
            log('info', 'message_deleted', { chatId, messageId, reason })
        } catch (error) {
            if (isRetryable(error)) throw error
            if (!matchesApiError(error, /message to delete not found/i)) {
                log('warn', 'message_delete_failed', { chatId, messageId, reason, error: errorMessage(error) })
            }
        }
    }

    async checkLoop() {
        let classifierFailures = 0
        while (!this.signal.aborted) {
            const check = this.storage.nextCheck(Date.now())
            if (!check) {
                await sleep(500, this.signal)
                continue
            }
            try {
                await this.processCheck(check)
                this.storage.finishCheck(check)
                classifierFailures = 0
            } catch (error) {
                if (this.signal.aborted) return
                const upstreamDelay = error instanceof ApiError || error instanceof ClassifierError ? error.retryAfter : 0
                const delay = retryDelay(check.attempts, upstreamDelay)
                this.storage.retryCheck(check, Date.now() + delay)
                log('warn', 'check_retry', { chatId: check.chatId, userId: check.userId, delay, error: errorMessage(error) })
                if (error instanceof ClassifierError) {
                    await sleep(retryDelay(classifierFailures++, upstreamDelay), this.signal)
                }
            }
        }
    }

    private async processCheck(check: Check) {
        const existing = this.storage.getCase(check.chatId, check.userId)
        const newText = !existing || (existing.status === 'pending' && existing.messageId !== check.messageId)
        const needsVerdict = newText && !this.storage.isScammer(check.userId) && !this.storage.isChecked(check.userId)
        const verdict = needsVerdict ? await classify(check.text, this.config, this.signal) : undefined
        if (verdict) log('info', 'check_completed', { chatId: check.chatId, userId: check.userId, verdict })

        await this.serialize(async () => {
            const current = this.storage.getCase(check.chatId, check.userId)
            const known = this.storage.isScammer(check.userId)
            if (current?.status === 'cleared') return
            if (!current && !known && verdict !== 'SCAM') {
                if (verdict === 'GOOD') this.storage.markChecked(check.userId)
                return
            }
            if (current?.status === 'pending' && current.messageId !== check.messageId && !known && verdict !== 'SCAM') return

            const report = current ?? this.storage.openCase(check)
            await this.deleteMessage(check.chatId, check.messageId, 'scam')
            if (!known && !this.config.auto) return
            if (report.status === 'banned' && report.messageId === check.messageId) return

            try {
                if (report.status === 'banned') {
                    const member = await this.telegram.call<{ status: string }>('getChatMember', {
                        chat_id: report.chatId, user_id: report.userId,
                    })
                    if (member.status === 'kicked') return
                }
                await this.applyAction(report, this.config.mode, 'automatic')
            } catch (error) {
                if (isRetryable(error)) throw error
                log('warn', 'automatic_action_failed', { caseId: report.id, error: errorMessage(error) })
            }
        })
    }

    async alertLoop() {
        while (!this.signal.aborted) {
            const alert = this.storage.nextAlert(Date.now())
            if (!alert) {
                await sleep(500, this.signal)
                continue
            }
            const { report, adminId, messageId } = alert
            const keyboard: Keyboard = {
                inline_keyboard: [buttons(report, this.config.mode).map(([action, text]) => ({
                    text, callback_data: `mod:${report.id}:${report.revision}:${action}`,
                }))],
            }
            const body = {
                chat_id: adminId,
                text: alertText(report),
                parse_mode: 'HTML',
                reply_markup: keyboard,
                link_preview_options: { is_disabled: true },
            }
            try {
                const sent = messageId === null
                    ? await this.telegram.call<Message>('sendMessage', body)
                    : await this.telegram.call<Message>('editMessageText', { ...body, message_id: messageId })
                this.storage.markAlert(report.id, adminId, sent.message_id, report.revision)
                log('info', 'alert_synced', { caseId: report.id, adminId, messageId: sent.message_id, revision: report.revision })
            } catch (error) {
                if (this.signal.aborted) return
                if (this.storage.getCaseById(report.id)?.revision !== report.revision) continue
                if (messageId !== null && matchesApiError(error, /message is not modified/i)) {
                    this.storage.markAlert(report.id, adminId, messageId, report.revision)
                    continue
                }
                if (messageId !== null && matchesApiError(error, /message to edit not found/i)) {
                    this.storage.clearAlert(report.id, adminId)
                    continue
                }
                const delay = isRetryable(error) ? retryDelay(alert.attempts, error instanceof ApiError ? error.retryAfter : 0) : 3_600_000
                this.storage.retryAlert(report.id, adminId, Date.now() + delay)
                log('warn', 'alert_retry', { caseId: report.id, adminId, delay, error: errorMessage(error) })
                if (!(error instanceof ApiError) || error.code >= 500) await sleep(Math.min(5_000, delay), this.signal)
            }
        }
    }

    private async onCallback(callback: CallbackQuery) {
        const adminId = callback.from.id
        if (!this.config.adminIds.includes(adminId) || callback.message?.chat.id !== adminId || callback.message.chat.type !== 'private') {
            await this.answer(callback.id, 'Доступ закрыт.')
            return
        }
        const button = callback.data?.match(/^mod:(\d+):(\d+):(ban|kick|unban|pardon|scam)$/)
        const legacy = button ? undefined : this.adoptLegacy(callback.message, callback.data)
        const report = button ? this.storage.getCaseById(Number(button[1])) : legacy?.report
        const action = button ? button[3] as Action : legacy?.action
        if (!report || !action || (button && Number(button[2]) !== report.revision)
            || this.storage.getAlertMessageId(report.id, adminId) !== callback.message.message_id
            || (!buttons(report, this.config.mode).some(([allowed]) => allowed === action)
                && !(legacy && report.status === 'pending' && (action === 'ban' || action === 'kick')))) {
            await this.answer(callback.id, 'Кнопка устарела. Проверьте последнее уведомление.')
            return
        }

        try {
            const updated = await this.applyAction(report, action, adminId)
            await this.answer(callback.id, actionResults[updated.status === 'banned' ? 'ban' : action])
        } catch (error) {
            if (isRetryable(error)) throw error
            log('warn', 'manual_action_failed', { caseId: report.id, adminId, action, error: errorMessage(error) })
            await this.answer(callback.id, 'Действие не выполнено. Проверьте права бота.')
        }
    }

    private adoptLegacy(message: Message, data: string | undefined) {
        const legacy = data?.match(/^(ban|kick|unban|pardon|scam):(-\d+):(\d+):(\d+):(\d+)$/)
        if (!legacy || Number(legacy[5]) !== message.message_id) return
        if (!message.reply_markup?.inline_keyboard.some(row => row.some(button => button.callback_data === data))) return
        const action = legacy[1] as Action
        const [chatId, userId, messageId] = legacy.slice(2, 5).map(Number)
        if (![chatId, userId, messageId].every(Number.isSafeInteger) || userId <= 0 || messageId <= 0) return
        const initial: Status = { unban: 'banned', pardon: 'scam', scam: 'cleared', ban: 'pending', kick: 'pending' }[action] as Status
        const report = this.storage.openCase({
            chatId, userId, messageId, chatTitle: String(chatId), name: String(userId), text: message.text ?? '',
        }, initial, action === 'scam' ? 'pardon' : null)
        if (this.storage.getAlertMessageId(report.id, message.chat.id) !== null) return
        this.storage.adoptAlert(report.id, message.chat.id, message.message_id)
        return { report, action }
    }

    private async applyAction(report: Case, action: Action, actor: number | 'automatic') {
        const target = { chat_id: report.chatId, user_id: report.userId }
        let status: Status
        let outcome: Outcome | null = actor === 'automatic' ? 'automatic' : null
        switch (action) {
            case 'ban':
                await this.telegram.call('banChatMember', target)
                status = 'banned'
                break
            case 'unban':
                await this.telegram.call('unbanChatMember', { ...target, only_if_banned: true })
                status = 'cleared'
                outcome = 'unban'
                break
            case 'kick': {
                const member = await this.telegram.call<{ status: string }>('getChatMember', target)
                if (member.status === 'kicked') {
                    status = 'banned'
                    outcome = null
                    break
                }
                if (member.status !== 'left') await this.telegram.call('unbanChatMember', { ...target, only_if_banned: false })
                status = 'kicked'
                break
            }
            case 'pardon': status = 'cleared'; outcome = 'pardon'; break
            case 'scam': status = 'scam'; break
        }
        const updated = this.storage.setStatus(report.id, status, outcome)
        log('info', 'moderation_action', { caseId: report.id, chatId: report.chatId, userId: report.userId, actor, action, status })
        return updated
    }

    private async answer(callbackId: string, text: string) {
        try {
            await this.telegram.call('answerCallbackQuery', { callback_query_id: callbackId, text }, 3000)
        } catch (error) {
            if (!this.signal.aborted) log('warn', 'callback_answer_failed', { error: errorMessage(error) })
        }
    }
}
