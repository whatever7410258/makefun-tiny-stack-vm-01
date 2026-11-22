// Tiny stack VM for make.fun tiny-stack-vm-01 (ISA v1, see kit ISA.md).
// One run answers all 40 instances: reads /input/<id>/program.bin +
// input.bin, writes /output/<id>/stdout.bin + exit.txt.
// Node 22, built-ins only. Deterministic: no clock, no env variation.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// How many values each opcode pops / pushes (ISA.md stack pictures).
const pops = new Uint8Array(256);
const pushes = new Uint8Array(256);
for (const o of [3, 4, 0x31, 0x32, 0x40, 0x50, 0x51, 0x53]) pops[o] = 1;
for (const o of [5, 6, 0x41]) pops[o] = 2;
for (let o = 0x10; o <= 0x22; o++) pops[o] = 2;
pops[0x17] = 1; pops[0x1b] = 1; pops[7] = 3;
for (let o = 0x10; o <= 0x22; o++) pushes[o] = 1;
pushes[1] = 1; pushes[2] = 1; pushes[4] = 2; pushes[5] = 2;
pushes[6] = 3; pushes[7] = 3; pushes[0x40] = 1; pushes[0x52] = 1;

const valid = (op: number): boolean => op <= 7 || (op >= 0x10 && op <= 0x22) ||
  (op >= 0x30 && op <= 0x34) || (op >= 0x40 && op <= 0x41) || (op >= 0x50 && op <= 0x53);

// Run one program; returns [bytes written, exit code (trap code included)].
function run(p: Uint8Array, inp: Uint8Array): [Uint8Array, number] {
  const n = p.length;
  const st = new Int32Array(256);
  let sp = 0;
  const cs = new Int32Array(64);
  let cp = 0;
  const mem = new Int32Array(256);
  const out = new Uint8Array(65536);
  let ol = 0, ip = 0, pc = 0, steps = 0;
  const end = (code: number): [Uint8Array, number] => [out.subarray(0, ol), code];
  for (;;) {
    if (steps === 1000000) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = p[pc];
    if (!valid(op)) return end(5);
    const im = op === 1 ? 1 : op === 2 ? 4 : (op >= 0x30 && op <= 0x33 ? 2 : 0);
    if (pc + im >= n) return end(9);
    steps++;
    const nx = pc + 1 + im;
    if (sp < pops[op]) return end(2);
    if (sp - pops[op] + pushes[op] > 256) return end(3);
    pc = nx;
    switch (op) {
      case 0x00: return end(0);
      case 0x01: st[sp++] = (p[nx - 1] << 24) >> 24; break;
      case 0x02: st[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break;
      case 0x03: sp--; break;
      case 0x04: st[sp] = st[sp - 1]; sp++; break;
      case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; }
      case 0x06: st[sp] = st[sp - 2]; sp++; break;
      case 0x07: { const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; break; }
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break;
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break;
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) { const v = st[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33:
        if (cp === 64) return end(7);
        cs[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34:
        if (cp === 0) return end(8);
        pc = cs[--cp];
        break;
      case 0x40: {
        const a = st[sp - 1];
        if (a < 0 || a >= 256) return end(6);
        st[sp - 1] = mem[a];
        break;
      }
      case 0x41: {
        const a = st[sp - 1], v = st[sp - 2];
        if (a < 0 || a >= 256) return end(6);
        sp -= 2; mem[a] = v;
        break;
      }
      case 0x50: {
        const s = String(st[sp - 1]);
        if (ol + s.length > 65536) return end(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51:
        if (ol + 1 > 65536) return end(11);
        out[ol++] = st[--sp] & 255;
        break;
      case 0x52:
        st[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53:
        return end(st[--sp] & 255);
      default: { // two-operand ops 0x10..0x22 except NEG/NOT above
        const b = st[sp - 1], a = st[sp - 2];
        let r = 0;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) { if (b === 0) return end(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; }
        else if (op === 0x14) { if (b === 0) return end(4); r = b === -1 ? 0 : (a % b) | 0; }
        else if (op === 0x15) { if (b === 0) return end(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 0x16) { if (b === 0) return end(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2; st[sp++] = r;
        break;
      }
    }
  }
}

for (const id of readdirSync(IN).sort()) {
  const dir = join(IN, id);
  let prog: Buffer, inp: Buffer;
  try { prog = readFileSync(join(dir, 'program.bin')); } catch { prog = Buffer.alloc(0); }
  try { inp = readFileSync(join(dir, 'input.bin')); } catch { inp = Buffer.alloc(0); }
  const [o, code] = run(prog, inp);
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'stdout.bin'), o);
  writeFileSync(join(OUT, id, 'exit.txt'), String(code) + '\n');
}
