import { SerialPort } from 'serialport';

/** Node 26.4+ may stall promise continuations resumed by native serial poller callbacks. */
export class CompatibleSerialPort extends SerialPort {
  private queuedImmediate?: NodeJS.Immediate;

  constructor(options: ConstructorParameters<typeof SerialPort>[0]) {
    super(options);
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (process.platform !== 'linux' && process.platform !== 'darwin' && process.platform !== 'freebsd') return;
    if (major < 26 || (major === 26 && minor < 4)) return;

    this.on('open', () => {
      const poller = (this as unknown as { port?: { poller?: NodeJS.EventEmitter } }).port?.poller;
      if (!poller) return;
      const wake = () => {
        if (this.queuedImmediate) return;
        this.queuedImmediate = setImmediate(() => { this.queuedImmediate = undefined; });
      };
      poller.on('readable', wake);
      poller.on('writable', wake);
      poller.on('disconnect', wake);
      this.once('close', () => {
        poller.off('readable', wake);
        poller.off('writable', wake);
        poller.off('disconnect', wake);
        if (this.queuedImmediate) clearImmediate(this.queuedImmediate);
        this.queuedImmediate = undefined;
      });
    });
  }
}
