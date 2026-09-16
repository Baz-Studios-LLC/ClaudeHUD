// Capture only a WoW window. Never substitute a whole-desktop screenshot.
async function captureGame({ desktopCapturer, displays }) {
  const width = Math.max(...displays.map(display => Math.ceil(display.size.width * display.scaleFactor)));
  const height = Math.max(...displays.map(display => Math.ceil(display.size.height * display.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height }, fetchWindowIcons: false });
  const games = sources.filter(source => /^World of Warcraft(?: Classic)?$/i.test(source.name.trim()));
  if (!games.length) throw new Error('Could not find World of Warcraft. Open the game in borderless mode and try again.');
  if (games.length > 1) throw new Error('More than one WoW window is open. Keep one game window open to capture it.');
  const image = games[0].thumbnail;
  if (image.isEmpty()) throw new Error('WoW could not be captured. Restore the game window and try again.');
  let bytes = image.toPNG(), type = 'image/png';
  if (bytes.length > 30 * 1024 * 1024) { bytes = image.toJPEG(92); type = 'image/jpeg'; }
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error('This screenshot exceeds the 30 MB attachment limit.');
  return { type, data: bytes.toString('base64') };
}
module.exports = { captureGame };
