let inflight = 0;

export function incCommands() { inflight += 1; }
export function decCommands() { if (inflight > 0) inflight -= 1; }
export function getInflightCommands() { return inflight; }

