import {createServer} from "node:http";
import {dirname,join} from "node:path";
import {homedir} from "node:os";
import {fileURLToPath} from "node:url";
import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {access} from "node:fs/promises";
import {createChatGPT} from "./.siwc/sdk/packages/local/dist/index.js";

const exec=promisify(execFile);
const root=dirname(fileURLToPath(import.meta.url));
let encryptionKey;
async function key(create=false) {
  if (!encryptionKey) {
    const {stdout}=await exec(join(root,".siwc","keychain-helper"),[create?"create":"read"],
      {encoding:"buffer", timeout:60000,maxBuffer:1024});
    if (stdout.length!==32) throw new Error("Keychain encryption is unavailable.");
    encryptionKey=stdout;
  }
  return encryptionKey;
}

const storageDir=join(homedir(),"Library","Application Support","LocalChat","ChatGPT");
const client=createChatGPT({
  appName:"mafokenLLM",
  appId:"app.localchat.siwc",
  sendHostId:true,
  redirectPort:0,
  storageDir,
  credentialEncryption:{
    id:"macos-keychain-aes-gcm-v1",
    async isAvailable(){try {await key();return true;}catch{return false;}},
    async encrypt(text){
      const nonce=randomBytes(12);
      const cipher=createCipheriv("aes-256-gcm",await key(),nonce);
      const body=Buffer.concat([cipher.update(text,"utf8"),cipher.final()]);
      return Buffer.concat([nonce,cipher.getAuthTag(),body]);
    },
    async decrypt(bytes){
      const b=Buffer.from(bytes);
      const cipher=createDecipheriv("aes-256-gcm",await key(),b.subarray(0,12));
      cipher.setAuthTag(b.subarray(12,28));
      return Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString("utf8");
    }
  },
  async openBrowser(url){
    const target=new URL(url);
    if(target.origin!=="https://auth.openai.com") throw new Error("Unexpected authorization destination.");
    await exec("/usr/bin/open",[target.href],{timeout:10000});
  }
});
const errors={
  cancelled:"Вход отменён.",
  sign_in_required:"Сначала войдите в ChatGPT.",
  sharing_not_enabled:"Разрешите mafokenLLM использовать тариф в окне входа ChatGPT.",
  storage_encryption_unavailable:"Разблокируйте Связку ключей macOS и повторите вход.",
  connection_busy:"Дождитесь окончания входа или отмените его.",
  network_error:"Не удалось связаться с ChatGPT.",
  reauth_required:"Войдите в ChatGPT повторно.",
  auth_required:"Войдите в ChatGPT повторно.",
};
function explain(err){
  if(err?.status===429) return "ChatGPT ограничил запрос. Проверьте остаток тарифа в ChatGPT.";
  return errors[err?.code] || "Операция ChatGPT не завершилась. Проверьте соединение и доступ к тарифу.";
}
let signing=null, signInError="";
async function snapshot(){
  if (signing) return {available:true,status:"connecting",sharing:false};
  try { await access(join(storageDir,"chatgpt-auth.json")); }
  catch(err) {
    if (err.code==="ENOENT") return {available:true,status:"disconnected",sharing:false,error:signInError};
    throw err;
  }
  const session=await client.getSession();
  return {available:true,status:session.status,sharing:session.sharing,
    account:session.identity?.email || session.identity?.name || "",
    error:signInError || (session.error ? explain(session.error) : "")};
}
function record(res,value){res.write(JSON.stringify(value)+"\n");}

const server=createServer(async (req,res)=>{
  res.setHeader("Content-Type","application/x-ndjson; charset=utf-8");
  let stage="account";
  try {
    switch(req.method+" "+req.url){
      case "GET /status":
        record(res,await snapshot());
        break;
      case "POST /begin":
        if(!signing){
          const cancel=new AbortController();
          signing=cancel;
          signInError="";
          (async()=>{
            try {
              try { await key(true); }
              catch { throw Object.assign(new Error(),{code:"storage_encryption_unavailable"}); }
              cancel.signal.throwIfAborted();
              const session=await client.signIn({reconsent:true,signal:cancel.signal});
              signInError=session.error?explain(session.error):"";
            }catch(err){signInError=cancel.signal.aborted ? errors.cancelled : explain(err);}
            finally{signing=null;}
          })();
        }
        record(res,{available:true,status:"connecting",sharing:false});
        break;
      case "POST /cancel":
        signing?.abort();
        client.cancelSignIn();
        record(res,await snapshot());
        break;
      case "POST /disconnect": {
        const result=await client.disconnect();
        signInError=result?.error?explain(result.error):"";
        record(res,await snapshot());
        break;
      }
      case "POST /respond": {
        stage="response";
        const cancel=new AbortController();
        res.once("close",()=>cancel.abort());
        const chunks=[];
        let size=0;
        for await(const part of req){
          size+=part.length;
          if(size>1024*1024) throw new Error("Too large.");
          chunks.push(part);
        }
        const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const models=await client.listModels({signal:cancel.signal});
        const model=models[0];
        if(!model){record(res,{error:"Тариф ChatGPT не вернул доступные модели."});break;}
        record(res,{source:"ChatGPT · тариф",model:model.displayName || model.slug,cloud:true});
        await client.streamResponse({model:model.slug,input:data.messages,instructions:data.instructions,
          signal:cancel.signal,onDelta:delta=>record(res,{delta})});
        record(res,{done:true});
        break;
      }
      default:
        res.statusCode=404;
        record(res,{error:"Неизвестная операция."});
    }
  }catch(err){
    record(res,stage==="response"?{error:explain(err)}:{available:true,status:"disconnected",sharing:false,error:explain(err)});
  }finally{res.end();}
});
process.umask(0o077);
server.listen(process.argv[2]);
if(!process.stdin.isTTY){
  process.stdin.resume();
  process.stdin.on("end",()=>process.exit(0));
}
