import { cursorAuthentication } from "../packages/server/src/cursor-auth.ts";
console.log(await cursorAuthentication(process.cwd()));
