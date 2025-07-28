# Contributing to GuruShots Auto Vote

Thank you for your interest in contributing to GuruShots Auto Vote! We welcome contributions from the community.

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ (required for CLI builds)
- Node.js 23+ (recommended for main development)
- npm (comes with Node.js)

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/gurushots-auto-vote.git
   cd gurushots-auto-vote
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start development:
   ```bash
   npm run dev
   ```

## 🛠️ Development

### Available Scripts

- `npm start` - Run the Electron app
- `npm run dev` - Development mode with hot reload
- `npm run lint` - Check code style
- `npm run lint:fix` - Fix code style issues
- `npm test` - Run tests (when available)

### Project Structure

```
src/
├── js/
│   ├── api/          # API modules for GuruShots integration
│   ├── cli/          # Command-line interface
│   ├── mock/         # Mock API for testing
│   ├── app.js        # Main renderer process
│   ├── index.js      # Main electron process
│   └── preload.js    # Preload script for security
├── html/             # HTML templates
├── styles/           # CSS styles (Tailwind)
└── assets/           # Images and other assets
```

## 📝 Code Guidelines

### Code Style

- We use ESLint for code linting
- 4-space indentation
- Single quotes for strings
- Semicolons are required
- Always run `npm run lint` before committing

### Security

- Never expose API keys or credentials
- Use context isolation and preload scripts
- Follow Electron security best practices
- No `nodeIntegration` in renderer processes

### Git Workflow

1. Create a feature branch from `master`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Run linting and tests:
   ```bash
   npm run lint
   ```
4. Commit with clear messages:
   ```bash
   git commit -m "feat: add new voting feature"
   ```
5. Push and create a pull request

### Commit Messages

We follow conventional commit format:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `chore:` - Maintenance tasks

## 🐛 Bug Reports

When reporting bugs, please include:
- Operating system and version
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
- Screenshots (if applicable)
- Log files (check `logs/` directory)

## 💡 Feature Requests

Before suggesting new features:
- Check existing issues and discussions
- Consider if it aligns with the project goals
- Provide clear use cases and benefits

## 🔄 Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all existing tests pass
4. Run linting and fix any issues
5. Update README.md if needed
6. Provide clear PR description

### PR Checklist

- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] Tests added/updated
- [ ] No breaking changes (or clearly documented)

## 🧪 Testing

### Mock Mode

Test your changes without real API calls:
```bash
npm run mock:start
```

### Manual Testing

- Test both GUI and CLI modes
- Verify on different platforms
- Check error handling
- Test with invalid credentials

## 📦 Building

### Local Build
```bash
npm run build
```

### Platform-Specific Builds
```bash
npm run build:win    # Windows
npm run build:mac    # macOS  
npm run build:linux  # Linux
```

## 🤝 Code of Conduct

- Be respectful and inclusive
- Help others learn and grow
- Focus on constructive feedback
- Respect project maintainers' decisions

## 📞 Getting Help

- Open an issue for bugs or questions
- Check existing documentation
- Review closed issues for similar problems

## 🎉 Recognition

Contributors will be recognized in:
- Release notes
- README.md contributors section
- Git commit history

Thank you for contributing! 🚀