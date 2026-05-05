import {
  configureTeamSource,
  handleTeamCommand
} from '../src/team-monitor.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'team-status';
  const aliases = {
    'source-add': 'team-source-add',
    'source-list': 'team-source-list',
    'source-remove': 'team-source-remove',
    'source-enable': 'team-source-enable',
    'source-disable': 'team-source-disable',
    'member-add': 'team-member-add',
    'member-list': 'team-member-list',
    'member-remove': 'team-member-remove',
    'dashboard-refresh': 'team-dashboard-refresh',
    'subscribe-events': 'team-subscribe-task-events',
    'subscribe-task-events': 'team-subscribe-task-events',
    digest: 'team-digest',
    qa: 'team-knowledge-qa',
    'knowledge-qa': 'team-knowledge-qa',
    unassigned: 'team-unassigned-list',
    reassign: 'team-reassign'
  };
  const normalized = aliases[command] || (command.startsWith('team-') ? command : `team-${command}`);
  const result = normalized === 'team-source-add'
    ? await configureTeamSource(args)
    : await handleTeamCommand(normalized, args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message
  }, null, 2));
  process.exit(1);
});
