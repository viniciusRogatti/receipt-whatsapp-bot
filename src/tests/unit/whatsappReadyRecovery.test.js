const assert=require('node:assert/strict');
const {installReadyRecovery}=require('../../services/whatsappReadyRecovery.service');
module.exports=()=>[{name:'ready recovery retries only transient event-binding failures without emitting ready',run:async()=>{
let calls=0;const client={pupPage:{isClosed:()=>false},attachEventListeners:async()=>{calls++;if(calls===1)throw Error('Protocol error: Target closed');return 'attached';}};installReadyRecovery(client,{warn:()=>{}});assert.equal(await client.attachEventListeners(),'attached');assert.equal(calls,2);
let bad=0;const permanent={pupPage:{isClosed:()=>false},attachEventListeners:async()=>{bad++;throw Error('Unauthorized');}};installReadyRecovery(permanent,{warn:()=>{}});await assert.rejects(()=>permanent.attachEventListeners(),/Unauthorized/);assert.equal(bad,1);
}}];
