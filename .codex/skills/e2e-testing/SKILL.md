---
name: e2e-testing
description: Create and maintain Playwright E2E tests for Bloom Mindful Companion. tailored for React/Vite/Shadcn application. Use when adding new E2E tests or debugging existing ones.
---

# E2E Testing with Playwright

Guidance for writing reliable End-to-End tests for the Bloom Mindful Companion application using Playwright.

## 📂 Structure

Tests are located in `tests/e2e/`.

```
tests/e2e/
├── fixtures/           # Shared test fixtures (users, data)
├── pages/              # Page Object Models (POM) - REQUIRED
├── specs/              # Test files (*.spec.ts)
└── utils/              # Shared helpers
```

## ⚡ Quick Start

1.  **Create Page Object**: Define the page/component interaction logic.
2.  **Write Test Spec**: Use the POM to assert user flows.
3.  **Run Tests**: `npm run test:e2e`

## 🏗️ Page Object Model (POM) Pattern

**ALWAYS** use Page objects. Do not write raw locators in test files.

```typescript
// tests/e2e/pages/LoginPage.ts
import { Page, Locator, expect } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly submitBtn: Locator;

  constructor(page: Page) {
    this.page = page;
    // PREFER: data-testid > role > label > text
    this.emailInput = page.getByTestId('email-input'); 
    this.submitBtn = page.getByRole('button', { name: 'Log in' });
  }

  async goto() {
    await this.page.goto('/login');
    await expect(this.emailInput).toBeVisible(); // Assert readiness
  }

  async login(email: string) {
    await this.emailInput.fill(email);
    await this.submitBtn.click();
  }
}
```

## 🏦 Best Practices

### 1. Locators
*   **Good**: `getByTestId('submit-btn')`, `getByRole('button', { name: 'Save' })`
*   **Bad**: `css=.foo > div`, `xpath=//div[3]` (Brittle!)
*   **Shadcn UI**: Often requires specific handling for Select/Popover.
    *   *Select*: Click trigger `getByRole('combobox')`, then click option `getByRole('option', { name: 'Value' })`.

### 2. Waiting
*   **NEVER** use `page.waitForTimeout(5000)`.
*   **USE** Auto-waiting assertions: `await expect(locator).toBeVisible()`.
*   **USE** `page.waitForURL('**/dashboard')` after navigation.

### 3. Isolation
*   Tests must be independent.
*   Use `test.beforeEach` to reset state if needed.
*   Don't rely on state from previous tests.

## 🧪 Example Test Spec

```typescript
// tests/e2e/specs/login.spec.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';

test.describe('Login Flow', () => {
  test('should allow user to login', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('test@example.com');
    
    await expect(page).toHaveURL('/dashboard');
  });
});
```

## 🏃 Running Tests

*   `npm run test:e2e` - Run all tests (headless)
*   `npm run test:e2e -- --ui` - Run with UI Mode (great for debugging)
*   `npm run test:e2e -- --project=chromium` - Run specific browser
*   `npm run test:e2e -- -g "Login"` - Run specific test
