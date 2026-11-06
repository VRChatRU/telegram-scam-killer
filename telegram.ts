export type User = {
    id: number
    is_bot: boolean
    first_name: string
    last_name?: string
    username?: string
}

export type Chat = {
    id: number
    type: 'private' | 'group' | 'supergroup' | 'channel'
    title?: string
    username?: string
}

export type Message = {
    message_id: number
    date: number
    chat: Chat
    from?: User
    sender_chat?: Chat
    text?: string
    caption?: string
    reply_markup?: Keyboard
}

export type CallbackQuery = {
    id: string
    from: User
    data?: string
    message?: Message
}

type ChatMember = {
    user: User
    status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
}

export type ChatMemberUpdated = {
    chat: Chat
    from: User
    date: number
    old_chat_member: ChatMember
    new_chat_member: ChatMember
}

export type Update = {
    update_id: number
    message?: Message
    edited_message?: Message
    callback_query?: CallbackQuery
    chat_member?: ChatMemberUpdated
}

export type Keyboard = {
    inline_keyboard: { text: string; callback_data: string }[][]
}

type ApiResponse<T> =
    | { ok: true; result: T }
    | { ok: false; error_code: number; description?: string; parameters?: { retry_after?: number } }

export class ApiError extends Error {
    constructor(
        readonly code: number,
        description: string,
        readonly retryAfter?: number,
    ) {
        super(description)
        this.name = 'ApiError'
    }
}

export class Telegram {
    constructor(
        private readonly token: string,
        private readonly signal: AbortSignal,
    ) {}

    async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
        const signal = AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)])
        let response: Response
        try {
            response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal,
                redirect: 'error',
            })
        } catch {
            throw new Error(`Telegram ${method} request ${signal.aborted ? 'aborted or timed out' : 'failed'}`)
        }

        const data = await response.json().catch(() => null) as ApiResponse<T> | null
        if (response.ok && data?.ok === true && 'result' in data) return data.result
        if (data?.ok === false && typeof data.error_code === 'number') {
            const description = typeof data.description === 'string'
                ? data.description.replaceAll(this.token, '[redacted]').replace(/[\r\n]+/g, ' ')
                : `HTTP ${response.status}`
            const retryAfter = data.parameters?.retry_after
            throw new ApiError(
                data.error_code,
                `Telegram ${method}: ${description}`,
                typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
            )
        }
        throw new Error(`Telegram ${method} returned an invalid response (HTTP ${response.status})`)
    }

    async getUpdates(offset: number | undefined): Promise<Update[]> {
        const updates = await this.call<Update[]>('getUpdates', {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'edited_message', 'callback_query', 'chat_member'],
        }, 35_000)
        if (!Array.isArray(updates) || updates.some(update => !Number.isSafeInteger(update?.update_id))) {
            throw new Error('Telegram getUpdates returned an invalid update list')
        }
        return updates
    }
}
