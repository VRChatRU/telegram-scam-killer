import { Moderation } from './moderation'
import { errorMessage, loadConfig, log, retryDelay, sleep, startHeartbeat } from './runtime'
import { Storage } from './storage'
import { ApiError, Telegram } from './telegram'

async function poll(telegram: Telegram, moderation: Moderation, signal: AbortSignal) {
    let offset: number | undefined
    let failures = 0
    while (!signal.aborted) {
        try {
            const updates = await telegram.getUpdates(offset)
            for (const update of updates) {
                if (signal.aborted) return
                await moderation.update(update)
                offset = update.update_id + 1
            }
            if (!updates.length) offset = undefined
            if (failures) log('info', 'telegram_poll_recovered')
            failures = 0
        } catch (error) {
            if (signal.aborted) return
            if (error instanceof ApiError && (error.code === 401 || error.code === 404)) throw error
            const delay = retryDelay(failures++, error instanceof ApiError ? error.retryAfter : 0)
            log('warn', 'telegram_poll_retry', { delay, error: errorMessage(error) })
            await sleep(delay, signal)
        }
    }
}

async function main() {
    const config = loadConfig()
    const storage = new Storage('telegram-scam-killer.db', config.adminIds)
    const controller = new AbortController()
    const { signal } = controller
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)

    const telegram = new Telegram(config.token, signal)
    const moderation = new Moderation(config, storage, telegram, signal)
    const stopHeartbeat = startHeartbeat(config.kumaUrl, signal)
    log('info', 'service_started', { admins: config.adminIds.length, mode: config.mode, automatic: config.auto, model: config.model })

    const workers = [poll(telegram, moderation, signal), moderation.checkLoop(), moderation.alertLoop()]
    try {
        await Promise.all(workers)
    } finally {
        stop()
        stopHeartbeat()
        await Promise.allSettled(workers)
        storage.close()
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        log('info', 'service_stopped')
    }
}

if (import.meta.main) {
    try {
        await main()
    } catch (error) {
        log('error', 'service_failed', { error: errorMessage(error) })
        process.exitCode = 1
    }
}
