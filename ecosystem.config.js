module.exports = {
  apps: [
    {
      name: "telegram-bot",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};