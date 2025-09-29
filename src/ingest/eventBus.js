import { EventEmitter } from 'events';

export const bus = new EventEmitter();

// Avoid unbounded listener warnings in long-running setups
try { bus.setMaxListeners?.(50); } catch {}