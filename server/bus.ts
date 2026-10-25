import { EventEmitter } from 'node:events';
import type { LiveEvent } from '../shared/types';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const bus = {
  publish(ev: LiveEvent) {
    emitter.emit('live', ev);
  },
  subscribe(fn: (ev: LiveEvent) => void) {
    emitter.on('live', fn);
    return () => emitter.off('live', fn);
  },
};
