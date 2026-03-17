# Skill Reader

AI-powered skill documentation reader and analyzer.

## Features

- 📁 Auto-loads skill directory structure
- 📝 Splits markdown files into logical blocks
- 🤖 AI-powered analysis for each block using Claude API
- 🎨 Beautiful split-pane UI with hover sync
- 💾 Caches analysis results to avoid redundant API calls
- ⚡ Real-time streaming analysis

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set your Anthropic API key:
```bash
# Windows
set ANTHROPIC_API_KEY=your_api_key_here

# macOS/Linux
export ANTHROPIC_API_KEY=your_api_key_here
```

3. Start the server:
```bash
npm start
```

4. Open http://localhost:3000 in your browser

## Usage

- Click any skill file in the left sidebar to load it
- The content will be split into blocks (frontmatter, H1, H2 sections)
- Hover over a block on the left to highlight its analysis on the right
- Analysis results are cached in the `result/` directory

## Project Structure

```
skill-reader/
├── skill/          # Your skill markdown files
├── result/         # Cached analysis results (auto-generated)
├── public/         # Frontend files
│   └── index.html
├── server.js       # Express server
└── package.json
```

## Tech Stack

- Backend: Node.js + Express
- Frontend: Vanilla JS + Marked.js
- AI: Claude Sonnet 4.6 via Anthropic SDK
