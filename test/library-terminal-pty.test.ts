import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("shipping launch acquires and releases native terminal modes in an isolated background PTY", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-terminal-"));
  try {
    const script = join(dir, "fixture.ts");
    await Bun.write(script, `import { launchLibrary } from ${JSON.stringify(resolve("src/library/terminal/index.ts"))};
const coverage = {sources:[],observations:[],scope:{},method:"literal",partial:false,limitations:[]};
const reader = {list:()=>({sessions:[],nextCursor:null}),sources:()=>[],coverage:()=>coverage,collections:()=>[],favorites:()=>[]};
await launchLibrary(reader as any);\n`);
    const python = `import os,pty,subprocess,select,time,fcntl,termios,struct,json
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
env=dict(os.environ,TERM='xterm-256color')
p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(script)}],stdin=slave,stdout=slave,stderr=slave,env=env)
os.close(slave)
out=b''
start=time.time()
sent=False
while time.time()-start<8:
 if select.select([master],[],[],0.05)[0]:
  try: out+=os.read(master,65536)
  except OSError: break
 if not sent and b'Atlas' in out:
  os.write(master,b'\\x03');sent=True
 if p.poll() is not None: break
if p.poll() is None: p.kill()
p.wait()
os.close(master)
print(json.dumps({'exit':p.returncode,'atlas':b'Atlas' in out,'alternateOn':b'\\x1b[?1049h' in out,'alternateOff':b'\\x1b[?1049l' in out,'mouseOff':b'\\x1b[?1000l' in out}))
`;
    const proc = Bun.spawn(["python3", "-c", python], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const result = JSON.parse(output);
    expect(result).toEqual({ exit: 0, atlas: true, alternateOn: true, alternateOff: true, mouseOff: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);
