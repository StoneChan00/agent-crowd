import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('D:/2_Projects/agent-crowd/data/agent-crowd.db', { readOnly: true });
console.log(d.prepare('select id,name,working_dir,max_hops from rooms').all());
console.log(d.prepare("select name,cwd,harness,enabled from characters where room_id='af796762-21f9-4191-9dc9-3db92b976bfa'").all());
