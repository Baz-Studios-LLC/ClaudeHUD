const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
class AttachmentStore {
  constructor(storage) { this.directory = storage + '.attachments'; }
  path(file) {
    if (typeof file !== 'string' || !/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(file)) throw new Error('Invalid saved screenshot reference.');
    return path.join(this.directory, file);
  }
  store(image) {
    if (!image.data) { this.path(image.file); return { type: image.type, file: image.file, url: `hud-image://image/${image.file}` }; }
    if (!extensions[image.type]) throw new Error('Unsupported saved screenshot.');
    const bytes = Buffer.from(image.data, 'base64');
    const file = createHash('sha256').update(bytes).digest('hex') + '.' + extensions[image.type];
    const target = this.path(file);
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target + '.tmp', bytes);
      fs.renameSync(target + '.tmp', target);
    }
    return { type: image.type, file, url: `hud-image://image/${file}` };
  }
  hydrate(image) { return image.data ? image : { type: image.type, data: fs.readFileSync(this.path(image.file)).toString('base64') }; }
}
module.exports = { AttachmentStore };
