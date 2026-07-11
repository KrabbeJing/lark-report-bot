import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function normalizeMessageUuid(value) {
  const uuid = String(value || '').trim();
  if (!uuid) return undefined;
  if (uuid.length <= 50) return uuid;
  const digest = createHash('sha256').update(uuid).digest('hex').slice(0, 32);
  return `msg-${digest}`;
}

function withMessageUuid(data, uuid) {
  const normalized = normalizeMessageUuid(uuid);
  return normalized ? { ...data, uuid: normalized } : data;
}

export class LarkMessenger {
  constructor(client) {
    this.client = client;
  }

  async replyText(messageId, text) {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  async sendText(chatId, text, uuid) {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: withMessageUuid({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }, uuid),
    });
  }

  async sendTextToOpenId(openId, text, uuid) {
    await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: withMessageUuid({
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }, uuid),
    });
  }

  async uploadImage(imagePath) {
    const res = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: createReadStream(imagePath),
      },
    });
    const imageKey = res?.data?.image_key ?? res?.image_key;
    if (!imageKey) {
      throw new Error(`image upload returned no image_key, response: ${JSON.stringify(res)}`);
    }
    return imageKey;
  }

  async replyImage(messageId, imageKey) {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  }

  async sendImage(chatId, imageKey, uuid) {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: withMessageUuid({
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      }, uuid),
    });
  }
}
