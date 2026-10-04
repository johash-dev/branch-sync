import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

describe("Claude permission MCP bridge", () => {
  it("lists the permission tool and forwards a decision", async () => {
    const server = createServer(async (req,res) => { let body="";for await(const chunk of req)body+=chunk;expect(req.headers["x-sync-bridge-token"]).toBe("fixture");expect(JSON.parse(body).tool_name).toBe("Bash");res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({behavior:"deny",message:"Not approved"})); });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address();if(!address||typeof address==="string")throw new Error("No listener");
    const child=spawn(process.execPath,[fileURLToPath(new URL("../packages/server/src/claude-permission-bridge.ts",import.meta.url))],{env:{...process.env,SYNC_PERMISSION_ENDPOINT:`http://127.0.0.1:${address.port}/decision`,SYNC_PERMISSION_TOKEN:"fixture"},windowsHide:true});
    const pending=new Map<number,(value:any)=>void>();
    readline.createInterface({input:child.stdout}).on("line",line=>{const message=JSON.parse(line);pending.get(message.id)?.(message.result||message.error);pending.delete(message.id)});
    const call=(id:number,method:string,params:unknown)=>new Promise<any>(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n")});
    try {const init=await call(1,"initialize",{protocolVersion:"2025-03-26"});expect(init.serverInfo.name).toBe("sync_permission");const tools=await call(2,"tools/list",{});expect(tools.tools[0].name).toBe("approve");const result=await call(3,"tools/call",{name:"approve",arguments:{tool_name:"Bash",input:{command:"echo hi"}}});expect(JSON.parse(result.content[0].text).behavior).toBe("deny");}
    finally {child.kill();server.close();}
  });
});
