# Development Guidelines

## Code Architecture
- **MCP Integration**: Always utilize MCP (Model Context Protocol) tools and resources first before implementing custom logic. Check available MCP servers for existing solutions.
- **Cross-Platform Consistency**: The application supports both Electron (GUI) and CLI interfaces. All core business logic must be shared and consistent between both implementations.

## File Management
- **Documentation Policy**: Do not create markdown files, README files, or other documentation unless explicitly requested by the user.
- **Prefer Editing**: Always edit existing files rather than creating new ones when possible.

## Testing Standards
- **Test Organization**: All test files must be placed in the `tests/` directory following proper Jest conventions and structure.
- **Mock Configuration**: Never use `mock: false` in any Jest or testing commands - use proper mocking strategies instead.

## UI/UX Standards
- **Styling Framework**: GUI application uses Tailwind CSS + DaisyUI for all styling components
- **Custom CSS Policy**: No custom CSS is allowed except for the predefined Latvian color theme (already defined in the project)
- **Component Consistency**: Follow DaisyUI component patterns and conventions for consistent user experience

## Code Quality
- **DRY Principle**: Prioritize code reuse over duplication. Extract common functionality into shared utilities, hooks, or components
- **Shared Logic**: Create reusable functions and modules that can be utilized across both Electron and CLI implementations

## Configuration Management
- **Settings Architecture**: The project uses a dedicated settings system for configuration management
- **Environment Variables**: Do not use environment variables (.env files) for application configuration - use the established settings logic instead
- **Configuration Consistency**: Ensure settings are accessible and consistent between GUI and CLI interfaces

## Development Commands
- **Linting**: Run `npm run lint` after code changes
- **Type Checking**: Run `npm run typecheck` to verify TypeScript types
- **Testing**: Use proper Jest test commands as defined in package.json
- **Testing Completion**: All tests must pass regardless of code changes (even if they are not related to the code being changed)
