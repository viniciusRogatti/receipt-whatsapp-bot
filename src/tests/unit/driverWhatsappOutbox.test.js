const assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createOutboxWorker } = require('../../services/driverWhatsappOutbox.service');
async function run(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'astro-outbox-test-'));
 const originalFetch=global.fetch;global.fetch=async()=>({ok:true,arrayBuffer:async()=>Buffer.from('fake-photo')});
 try {
  let count=0, sync=0, completed=[], lostAck=true;
  const job={id:1,groupId:'123@g.us',groupName:'Canhotos Pronto',kind:'receipt',message:'123456',evidence:{base64:Buffer.from('fake-photo').toString('base64'),mimeType:'image/jpeg'},communicationStatus:'sending',recovery:false};
  const client={getChatById:async()=>({isGroup:true,id:{_serialized:'123@g.us'}}),sendMessage:async(group,media,options)=>{assert.equal(group,'123@g.us');assert.equal(options.caption,'123456');count++;return {id:{_serialized:'real-wa-id'},timestamp:100};}};
  const api=async(route,options)=>{if(route==='/outbox')return {items:[{id:1}]};if(route.endsWith('/claim'))return job;completed.push(options.body);if(lostAck){lostAck=false;throw Error('response lost');}return {};};
  const worker=createOutboxWorker({api,client,MessageMedia:class {},directory,processReceipt:async()=>{sync++;},logger:{warn:()=>{}}});
  await worker.tick();assert.equal(count,1);await worker.tick();assert.equal(count,1);assert.equal(sync,1);assert.equal(completed.at(-1).status,'sent');
  await fs.writeFile(path.join(directory,'1.json'),JSON.stringify({attempted:true,item:job}));job.recovery=true;
  await worker.tick();assert.equal(count,1);assert.equal(completed.at(-1).status,'uncertain');
  await fs.rm(path.join(directory,'1.json'));job.recovery=false;client.getChatById=async()=>({isGroup:false});await worker.tick();assert.equal(count,1);assert.equal(completed.at(-1).status,'failed');
  console.log('OK bot outbox: fixed group, strict caption, photo, recovery without duplicate send, ambiguous result, invalid group.');
 }finally{global.fetch=originalFetch;await fs.rm(directory,{recursive:true,force:true});}
}
module.exports = () => [{ name: 'driverWhatsappOutbox envia ao grupo correto e recupera sem duplicar', run }];
if (require.main === module) run().catch(e=>{console.error(e);process.exitCode=1;});
