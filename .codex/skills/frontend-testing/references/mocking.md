# Mocking Guide for Bloom Frontend Tests

## ⚠️ Important: What NOT to Mock

### DO NOT Mock Base Components

**Never mock components from `@/components/ui/`** such as:

- `Button`, `Input`, `Select`
- `Card`, `Dialog`, `DropdownMenu`
- `Label`, `Badge`, `Toast`

**Why?**

- Base components will have their own dedicated tests
- Mocking them creates false positives (tests pass but real integration fails)
- Using real components tests actual integration behavior

```typescript
// ❌ WRONG: Don't mock base components
vi.mock('@/components/ui/button', () => ({ children }: any) => <button>{children}</button>)

// ✅ CORRECT: Import and use real base components
import { Button } from '@/components/ui/button'
// They will render normally in tests
```

### What TO Mock

Only mock these categories:

1. **API services** (`@/services/*`) - Network calls
2. **Complex context providers** - When setup is too difficult
3. **Third-party libraries with side effects** - `react-router-dom`, external SDKs

## Mock Placement

| Location | Purpose |
|----------|---------|
| `vitest.setup.ts` | Global mocks shared by all tests |
| `src/__mocks__/` | Reusable mock factories shared across multiple test files |
| Test file | Test-specific mocks, inline with `vi.mock()` |

Modules are not mocked automatically. Use `vi.mock` in test files, or add global mocks in `vitest.setup.ts`.

## Essential Mocks

### 1. React Router

```typescript
const mockNavigate = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/current-path', search: '' }),
    useParams: () => ({ id: '123' }),
  }
})

describe('Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should navigate on click', () => {
    render(<Component />)
    fireEvent.click(screen.getByRole('button'))
    expect(mockNavigate).toHaveBeenCalledWith('/expected-path')
  })
})
```

### 2. API Service Mocks

```typescript
import * as api from '@/services/api'

vi.mock('@/services/api')

const mockedApi = vi.mocked(api)

describe('Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    
    // Setup default mock implementation
    mockedApi.fetchData.mockResolvedValue({ data: [] })
  })

  it('should show data on success', async () => {
    mockedApi.fetchData.mockResolvedValue({ data: [{ id: 1 }] })
    
    render(<Component />)
    
    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument()
    })
  })
})
```

### 3. React Query

To test components using React Query, wrap them in a Test QueryClientProvider:

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const createTestQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
})

const renderWithQueryClient = (ui: React.ReactElement) => {
  const queryClient = createTestQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  )
}
```

## Mock Best Practices

### ✅ DO

1. **Use real base components** - Import from `@/components/ui/` directly
1. **Use real project components** - Prefer importing over mocking
1. **Reset mocks in `beforeEach`**, not `afterEach`
1. **Match actual component behavior** in mocks (when mocking is necessary)
1. **Use factory functions** for complex mock data
1. **Import actual types** for type safety

### ❌ DON'T

1. **Don't mock base components** (`Button`, `Card`, etc.)
1. Don't mock components you can import directly
1. Don't use `any` types in mocks without necessity

### Mock Decision Tree

```
Need to use a component in test?
│
├─ Is it from @/components/ui/*?
│  └─ YES → Import real component, DO NOT mock
│
├─ Is it a project component?
│  └─ YES → Prefer importing real component
│           Only mock if setup is extremely complex
│
├─ Is it an API service (@/services/*)?
│  └─ YES → Mock it
│
├─ Is it a third-party lib with side effects?
│  └─ YES → Mock it (react-router-dom, etc)
```

## Factory Function Pattern

```typescript
// src/__mocks__/data-factories.ts
import type { User } from '@/types/user'

export const createMockUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  name: 'Test User',
  email: 'test@example.com',
  ...overrides,
})

// Usage in tests
it('should display user name', () => {
  const user = createMockUser({ name: 'John Doe' })
  render(<UserCard user={user} />)
  expect(screen.getByText('John Doe')).toBeInTheDocument()
})
```
