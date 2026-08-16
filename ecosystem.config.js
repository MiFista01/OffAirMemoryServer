module.exports = {
  apps: [{
    name: "off-air-memory-server",
    script: "dist/main.js",
    interpreter: "bun",
    instances: 1,
    exec_mode: "fork",
    env: {
      NODE_ENV: "production",
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
    },
  }]
};
