// Synthetic dependency injection only; production has no fault environment flags.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
let method, fired = false, syncCount = 0;
parentPort.on('message', message => { method = message.method; });
const trigger = () => !fired && method === (workerData.faultMethod || 'setDisabled');
const open = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args) => {
  const handle = await open(...args), sync = handle.sync.bind(handle);
  handle.sync = async () => {
    if (trigger() && ['slow', 'fsync_failure'].includes(workerData.fault) && ++syncCount === (workerData.faultNthSync || 1)) {
      fired = true;
      if (workerData.fault === 'slow') await new Promise(resolve => setTimeout(resolve, workerData.delayMs || 20000));
      else throw Object.assign(new Error('synthetic'), { code: 'EIO' });
    }
    return sync();
  };
  return handle;
};
const rename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (...args) => {
  const result = await rename(...args);
  if (trigger() && workerData.fault === 'crash_after_rename') { fired = true; process.exit(19); }
  return result;
};
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => {
  if (trigger() && workerData.fault === 'lost_reply' && message.ok) { fired = true; return; }
  post(message);
};
require(workerData.entry);
