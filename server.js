require('dotenv').config();
const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const treeKill = require('tree-kill');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const User = require('./models/User');
const Project = require('./models/Project');

const APP_PORT = process.env.PORT || 4477;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/launchpad';
const JWT_SECRET = process.env.JWT_SECRET || 'launchpad_dev_secret_key_default_9988';

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint for UptimeRobot / Keep-alive
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Connect to MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => console.log(`✓ Connected to MongoDB (${MONGO_URI})`))
  .catch((err) => {
    console.error(`✗ MongoDB Connection Error: ${err.message}`);
    console.log(`  Ensure MongoDB is running or set MONGO_URI in .env`);
  });

// ESM 'open' dynamic import helper
async function openBrowser(url) {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch (err) {
    console.log(`(could not auto-open browser: ${err.message})`);
  }
}

// Native OS Folder Dialog
function openFolderDialog() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $f = New-Object System.Windows.Forms.FolderBrowserDialog
        $f.Description = "Select Project Folder"
        $f.ShowNewFolderButton = $true
        $topForm = New-Object System.Windows.Forms.Form
        $topForm.TopMost = $true
        $result = $f.ShowDialog($topForm)
        if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Output $f.SelectedPath
        }
      `;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], (err, stdout) => {
        if (err) return resolve({ canceled: true, error: err.message });
        const selected = stdout ? stdout.trim() : '';
        if (!selected) return resolve({ canceled: true });
        resolve({ path: selected });
      });
    } else if (process.platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "Select Project Folder")';
      execFile('osascript', ['-e', script], (err, stdout) => {
        if (err) return resolve({ canceled: true });
        const selected = stdout ? stdout.trim() : '';
        resolve(selected ? { path: selected } : { canceled: true });
      });
    } else {
      execFile('zenity', ['--file-selection', '--directory', '--title=Select Project Folder'], (err, stdout) => {
        if (err) {
          execFile('kdialog', ['--getexistingdirectory', '.'], (kerr, kstdout) => {
            if (kerr) return resolve({ canceled: true });
            const selected = kstdout ? kstdout.trim() : '';
            resolve(selected ? { path: selected } : { canceled: true });
          });
          return;
        }
        const selected = stdout ? stdout.trim() : '';
        resolve(selected ? { path: selected } : { canceled: true });
      });
    }
  });
}

function detectProjectInfo(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return {};
  const base = path.basename(dirPath);
  const info = {
    suggestedName: base ? base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '',
    suggestedCommand: '',
    suggestedPort: null,
  };

  const pkgPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) {
        info.suggestedName = pkg.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (pkg.scripts) {
        if (pkg.scripts.dev) info.suggestedCommand = 'npm run dev';
        else if (pkg.scripts.start) info.suggestedCommand = 'npm start';
        else if (pkg.scripts.serve) info.suggestedCommand = 'npm run serve';
      }
    } catch {}
  } else if (fs.existsSync(path.join(dirPath, 'run.py'))) {
    info.suggestedCommand = 'python run.py server';
  } else if (fs.existsSync(path.join(dirPath, 'main.py'))) {
    info.suggestedCommand = 'python main.py';
  } else if (fs.existsSync(path.join(dirPath, 'app.py'))) {
    info.suggestedCommand = 'python app.py';
  } else if (fs.existsSync(path.join(dirPath, 'Cargo.toml'))) {
    info.suggestedCommand = 'cargo run';
  } else if (fs.existsSync(path.join(dirPath, 'go.mod'))) {
    info.suggestedCommand = 'go run .';
  }

  if (!info.suggestedCommand) info.suggestedCommand = 'npm run dev';
  return info;
}

// Runtime in-memory process state
const runtime = new Map();
const MAX_LOG_LINES = 500;

function getState(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      proc: null,
      pid: null,
      status: 'stopped',
      logs: [],
      clients: new Set(),
      startedAt: null,
    });
  }
  return runtime.get(id);
}

function pushLog(id, line) {
  const state = getState(id);
  state.logs.push(line);
  if (state.logs.length > MAX_LOG_LINES) state.logs.shift();
  for (const res of state.clients) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ---- AUTH ROUTES ----
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = new User({
      username,
      email: email.toLowerCase(),
      password: hashedPassword,
    });
    await user.save();

    const token = jwt.sign({ id: user._id, email: user.email, username: user.username }, JWT_SECRET, {
      expiresIn: '30d',
    });

    res.json({
      token,
      user: { id: user._id, email: user.email, username: user.username },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user._id, email: user.email, username: user.username }, JWT_SECRET, {
      expiresIn: '30d',
    });

    res.json({
      token,
      user: { id: user._id, email: user.email, username: user.username },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- PROTECTED PROJECT ROUTES ----
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const projects = await Project.find({ userId: req.user.id }).sort({ createdAt: -1 });
    const withStatus = projects.map((p) => {
      const doc = p.toObject();
      return {
        ...doc,
        status: getState(p._id.toString()).status,
      };
    });
    res.json(withStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', authenticateToken, async (req, res) => {
  try {
    const { name, dir, command, port, autoOpen } = req.body;
    if (!name || !dir || !command) {
      return res.status(400).json({ error: 'Name, folder path, and command are required' });
    }

    const project = new Project({
      userId: req.user.id,
      name,
      dir,
      command,
      port: port ? Number(port) : null,
      autoOpen: autoOpen !== false,
    });

    await project.save();
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const { name, dir, command, port, autoOpen } = req.body;
    const project = await Project.findOne({ _id: req.params.id, userId: req.user.id });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (name !== undefined) project.name = name;
    if (dir !== undefined) project.dir = dir;
    if (command !== undefined) project.command = command;
    if (port !== undefined) project.port = port ? Number(port) : null;
    if (autoOpen !== undefined) project.autoOpen = autoOpen;

    await project.save();
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const project = await Project.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const pId = req.params.id;
    const state = runtime.get(pId);
    if (state && state.pid) {
      try { treeKill(state.pid); } catch {}
    }
    runtime.delete(pId);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a project
app.post('/api/start/:id', authenticateToken, async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, userId: req.user.id });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const pId = project._id.toString();
    const state = getState(pId);
    if (state.status === 'running') return res.json({ ok: true, alreadyRunning: true });

    if (!project.dir || !fs.existsSync(project.dir)) {
      return res.status(400).json({ error: `Folder not found: ${project.dir}` });
    }

    state.logs = [];
    state.status = 'starting';

    const child = spawn(project.command, {
      cwd: project.dir,
      shell: true,
      env: process.env,
    });

    state.proc = child;
    state.pid = child.pid;
    state.status = 'running';
    state.startedAt = Date.now();

    pushLog(pId, `$ ${project.command}`);
    pushLog(pId, `# started in ${project.dir} (pid ${child.pid})`);

    child.stdout.on('data', (d) => pushLog(pId, d.toString()));
    child.stderr.on('data', (d) => pushLog(pId, d.toString()));

    child.on('exit', (code) => {
      pushLog(pId, `# process exited with code ${code}`);
      state.status = 'stopped';
      state.pid = null;
      state.proc = null;
    });

    child.on('error', (err) => {
      pushLog(pId, `# error: ${err.message}`);
      state.status = 'stopped';
      state.pid = null;
      state.proc = null;
    });

    if (project.autoOpen && project.port) {
      setTimeout(() => {
        if (state.status === 'running') {
          openBrowser(`http://localhost:${project.port}`);
        }
      }, 2500);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop a project
app.post('/api/stop/:id', authenticateToken, async (req, res) => {
  try {
    const pId = req.params.id;
    const state = getState(pId);
    if (!state.pid) {
      state.status = 'stopped';
      return res.json({ ok: true });
    }

    treeKill(state.pid, 'SIGTERM', (err) => {
      if (err) {
        try { process.kill(state.pid); } catch {}
      }
      state.status = 'stopped';
      state.pid = null;
      state.proc = null;
      pushLog(pId, `# stopped by user`);
      res.json({ ok: true });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live SSE Log stream for a project
app.get('/api/logs/:id', (req, res) => {
  const { id } = req.params;
  const state = getState(id);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  for (const line of state.logs) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  state.clients.add(res);
  req.on('close', () => state.clients.delete(res));
});

// Open folder in Explorer
app.post('/api/open-folder/:id', authenticateToken, async (req, res) => {
  try {
    const project = await Project.findOne({ _id: req.params.id, userId: req.user.id });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.dir || !fs.existsSync(project.dir)) {
      return res.status(404).json({ error: 'Folder does not exist' });
    }

    await openBrowser(project.dir);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Native folder picker
app.post('/api/browse-folder', async (req, res) => {
  try {
    const result = await openFolderDialog();
    if (result.canceled || !result.path) {
      return res.json({ canceled: true });
    }
    const details = detectProjectInfo(result.path);
    res.json({
      canceled: false,
      path: result.path,
      ...details,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clean shutdown handler
function shutdownAll() {
  for (const [id, state] of runtime.entries()) {
    if (state.pid) {
      try { treeKill(state.pid); } catch {}
    }
  }
}
process.on('SIGINT', () => { shutdownAll(); process.exit(0); });
process.on('SIGTERM', () => { shutdownAll(); process.exit(0); });

app.listen(APP_PORT, () => {
  console.log(`\n  🚀 Launchpad Backend running on port ${APP_PORT}\n`);
});
