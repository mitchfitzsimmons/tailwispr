const { execFile } = require('child_process');
const os = require('os');

let handsFreeActive = false;

async function triggerWispr(action) {
  if (os.platform() !== 'darwin') {
    throw new Error('Wispr trigger is only supported on macOS');
  }

  let url;
  if (action === 'start') {
    url = 'wispr-flow://start-hands-free';
    handsFreeActive = true;
  } else if (action === 'stop') {
    url = 'wispr-flow://stop-hands-free';
    handsFreeActive = false;
  } else {
    // Toggle
    handsFreeActive = !handsFreeActive;
    url = handsFreeActive ? 'wispr-flow://start-hands-free' : 'wispr-flow://stop-hands-free';
  }

  return new Promise((resolve, reject) => {
    execFile('open', [url], (err) => {
      if (err) {
        reject(new Error(`Wispr trigger failed: ${err.message}`));
      } else {
        resolve(handsFreeActive ? 'started' : 'stopped');
      }
    });
  });
}

module.exports = { triggerWispr };
