import { Database } from 'bun:sqlite'
import { Telegraf } from 'telegraf'

const db = new Database('antiscam_db.sqlite', { create: true })
const bot = new Telegraf(Bun.env.BOT_TOKEN)

db.run('CREATE TABLE IF NOT EXISTS checked_users (id INTEGER NOT NULL UNIQUE PRIMARY KEY)')
db.run('CREATE TABLE IF NOT EXISTS scammers (id INTEGER NOT NULL UNIQUE PRIMARY KEY)')

bot.on('message', async ctx => {
    if (ctx.chat && ctx.chat.type.includes('group') && ctx.message.from && ctx.message.text) {
        try {
            if(isUserChecked(ctx.message.from.id)) return
            if(isUserScammer(ctx.message.from.id)) { if(Bun.env.AUTO_BAN_OR_KICK !== 'kick') await ctx.banChatMember(ctx.message.from.id) }//ну хз
            if(!await isScam(ctx.message.text)) { recordUser(ctx.message.from.id, { scam: false }); return }
            await alertAdmin({
                userId: ctx.message.from.id,
                username: ctx.message.from.username,
                firstName: ctx.message.from.first_name,
                lastName: ctx.message.from.last_name,
                chatId: ctx.chat.id,
                chatTitle: ctx.chat.title,
                messageId: ctx.message.message_id,
                message: ctx.message.text
            })
            await ctx.deleteMessage()
            if(Bun.env.AUTO_MODERATION === 'true') {
                recordUser(ctx.message.from.id, { scam: true })
                await ctx.banChatMember(ctx.message.from.id)
                if(Bun.env.AUTO_BAN_OR_KICK === 'kick') await ctx.unbanChatMember(ctx.message.from.id)
            }
        } catch (error) {
            console.error('Error:', error)
            await bot.telegram.sendMessage(Bun.env.ADMIN_ID, '❌ Ошибка при проверке пользователя```\n' + error + '```', { parse_mode: 'Markdown' })
        }
    }
})

bot.action(/^[a-z]{3,6}:-?\d+:-?\d+:-?\d+:-?\d+$/, async ctx => {
    if(ctx.from.id !== Number(Bun.env.ADMIN_ID)) return
    try {
        const data = ctx.callbackQuery.data.split(':')
        const action = data[0]
        const chatId = Number(data[1])
        const userId = Number(data[2])
        const messageId = Number(data[3])
        const alertMessageId = Number(data[4])

        if(action === 'ban') {
            await ctx.telegram.banChatMember(chatId, userId)
            recordUser(userId, { scam: true })
            bot.telegram.editMessageReplyMarkup(Bun.env.ADMIN_ID, alertMessageId, undefined, {
                inline_keyboard: [[{ text: 'Забанен ✅ Разбанить? 😅', callback_data: `unban:${chatId}:${userId}:${messageId}:${alertMessageId}` }]]
            })
        } else if (action === 'unban') {
            await ctx.telegram.unbanChatMember(chatId, userId)
            recordUser(userId, { scam: false })
            bot.telegram.editMessageReplyMarkup(Bun.env.ADMIN_ID, alertMessageId, undefined, {
                inline_keyboard: [[{ text: 'Разбанен ✅ Забанить? 💀', callback_data: `ban:${chatId}:${userId}:${messageId}:${alertMessageId}` }]]
            })
        } else if (action === 'kick') {
            await ctx.telegram.banChatMember(chatId, userId)
            await ctx.telegram.unbanChatMember(chatId, userId)
            recordUser(userId, { scam: true })
            bot.telegram.editMessageReplyMarkup(Bun.env.ADMIN_ID, alertMessageId, undefined, {
                inline_keyboard: [[{ text: 'Кикнут ✅ Не скаммер? 😅', callback_data: `pardon:${chatId}:${userId}:${messageId}:${alertMessageId}` }]]
            })
        } else if (action === 'pardon') {
            recordUser(userId, { scam: false })
            bot.telegram.editMessageReplyMarkup(Bun.env.ADMIN_ID, alertMessageId, undefined, {
                inline_keyboard: [[{ text: 'Не скаммер ✅ Пометить как скамера? 💀', callback_data: `scam:${chatId}:${userId}:${messageId}:${alertMessageId}` }]]
            })
        } else if (action === 'scam') {
            recordUser(userId, { scam: true })
            bot.telegram.editMessageReplyMarkup(Bun.env.ADMIN_ID, alertMessageId, undefined, {
                inline_keyboard: [[{ text: 'Помечен как скаммер ✅ Отменить? 😅', callback_data: `pardon:${chatId}:${userId}:${messageId}:${alertMessageId}` }]]
            })
        }
    } catch (error) {
        console.error('Error: ', error)
        await ctx.reply('❌ Ошибка действия```\n' + error + '```', { parse_mode: 'Markdown' })
    }
})

//DETECT INVITE

bot.launch()
console.log('Бот запущен!')

const isUserCheckedQuery = db.prepare('SELECT 1 FROM checked_users WHERE id = ? LIMIT 1')
function isUserChecked(id) {
    const result = isUserCheckedQuery.get(id)
    return result !== null
}

const isUserScammerQuery = db.prepare('SELECT 1 FROM scammers WHERE id = ? LIMIT 1')
function isUserScammer(id) {
    const result = isUserScammerQuery.get(id)
    return result !== null
}

const recordUserQuery = db.prepare('INSERT OR IGNORE INTO checked_users (id) VALUES (?)')
const deleteRecordUserQuery = db.prepare('DELETE FROM checked_users WHERE id = ?')
const recordScammerQuery = db.prepare('INSERT OR IGNORE INTO scammers (id) VALUES (?)')
const deleteRecordScammerQuery = db.prepare('DELETE FROM scammers WHERE id = ?')

function recordUser(id, { scam }) {
    if(scam) {
        deleteRecordUserQuery.run(id)
        recordScammerQuery.run(id)
    } else {
        deleteRecordScammerQuery.run(id)
        recordUserQuery.run(id)
    }
}

async function isScam(message, attempt = 1) {
    const maxAttempts = 3
    try {
        const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${Bun.env.OPENROUTER_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: Bun.env.OPENROUTER_MODEL,
                messages: [
                    { role: 'user', content: Bun.env.PROMT },
                    { role: 'user', content: message },
                ],
            }),
            timeout: 10000,
        })

        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`)
        }

        const data = await response.json()
        const verdict = data.choices?.[0]?.message?.content?.trim()
        console.log(verdict)
        return verdict === 'SCAM'

    } catch (error) {
        console.warn(`Fetch error №${attempt}:`, error.message)
        if (attempt < maxAttempts) {
            return isScam(message, attempt + 1)
        } else {
            throw new Error(`Проверка на скам провалилась ${error.message}`)
        }
    }
}

function fetchWithTimeout(resource, options = {}) {
    const { timeout = 10000 } = options
    return Promise.race([
        fetch(resource, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Fetch timeout')), timeout)
        )
    ])
}

async function alertAdmin({ userId, username, firstName, lastName, chatId, chatTitle, messageId, message }) {
    try {
        const name = [firstName, lastName, username, userId].filter(Boolean).join(' ')
        await bot.telegram.sendMessage(Bun.env.ADMIN_ID, `⚠️ Скаммер *${name}* в чате *${chatTitle}*\n` + '```\n' + message + '```\n', { parse_mode: 'Markdown' })
            .then(alertMessage => {
                bot.telegram.editMessageReplyMarkup(Bun.env.ADMIN_ID, alertMessage.message_id, undefined, {
                    inline_keyboard: [
                        [
                            Bun.env.AUTO_MODERATION !== 'true'?
                            Bun.env.AUTO_BAN_OR_KICK === 'kick'?
                            { text: 'Кикнуть 💀', callback_data: `kick:${chatId}:${userId}:${messageId}:${alertMessage.message_id}` } : 
                            { text: 'Забанить 💀', callback_data: `ban:${chatId}:${userId}:${messageId}:${alertMessage.message_id}` } :
                            Bun.env.AUTO_BAN_OR_KICK === 'kick'?
                            { text: 'Не скаммер 😅', callback_data: `pardon:${chatId}:${userId}:${messageId}:${alertMessage.message_id}`} :
                            { text: 'Разбанить 😅', callback_data: `unban:${chatId}:${userId}:${messageId}:${alertMessage.message_id}`}
                        ]
                    ]
                })
            })
    } catch (error) {
        console.error(error)
    }
}

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))