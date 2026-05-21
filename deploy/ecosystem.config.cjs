module.exports = {
  apps: [
    {
      name: "gplan-ai",
      script: "npm",
      args: "run start",
      cwd: "/opt/gplan",
      env: {
        NODE_ENV: "production",
        PORT: "3001"
      },
      max_memory_restart: "700M",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false
    }
  ]
};

