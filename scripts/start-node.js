'use strict';

const profiles = {
  1: '.env.node1',
  2: '.env.node2',
  3: '.env.node3',
};

const nodeId = Number(process.argv[2]);
const envFile = profiles[nodeId];

if (!envFile) {
  console.error('Usage: node scripts/start-node.js <1|2|3>');
  process.exit(1);
}

process.env.ENV_FILE = envFile;
require('../index');
