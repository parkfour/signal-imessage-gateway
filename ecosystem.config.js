module.exports = {
  apps: [{
    name: 'signal-imessage-gateway',
    script: 'bridge.js',
    cwd: '/usr/local/src/signal-imessage-gateway',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    time: true,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
