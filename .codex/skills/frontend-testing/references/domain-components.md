# Domain Component Testing Guide

This guide covers testing patterns for Bloom's domain-specific components.

## General Principles

1. **Test Business Logic**: Focus tests on the specific business rules of the component (e.g., assessment scoring, chat flow logic).
2. **Mock Services**: Mock the service layer (`@/services/*`) to simulate backend responses and error states.
3. **Integration Style**: Use integration tests where multiple components interact to deliver a feature (e.g., a Chat window with message list and input).

## Assessment Components

When testing assessment components:

### Key Test Areas

1. **Rendering**: Ensure questions and options render correctly.
2. **Interaction**: Verify option selection updates state.
3. **Scoring**: If logic is frontend-side, verify scoring calculations.
4. **Submission**: specific tests for submitting the assessment.

### Example Pattern

```typescript
describe('PHQ9Assessment', () => {
  it('should render questions', () => {
    // Arrange
    const questions = mockQuestions() // Factory
    
    // Act
    render(<Assessment questions={questions} />)
    
    // Assert
    expect(screen.getByText(questions[0].text)).toBeInTheDocument()
  })

  it('should enable submit button after completion', async () => {
    // ... simulate answering all questions ...
    await user.click(screen.getByRole('button', { name: /submit/i }))
    expect(mockSubmit).toHaveBeenCalled()
  })
})
```

## Chat Components

When testing chat interfaces:

### Key Test Areas

1. **Message List**: Verify messages (user & bot) are displayed.
2. **Input**: Verify typing and sending messages.
3. **Loading States**: Verify "Typing..." or loading indicators during API calls.
4. **Error Handling**: Verify error toasts or messages on failed sends.

### Example Pattern

```typescript
describe('ChatWindow', () => {
  it('should display messages', () => {
    const messages = [
        createMockMessage({ role: 'user', content: 'Hello' }),
        createMockMessage({ role: 'assistant', content: 'Hi there' })
    ]
    
    render(<ChatWindow messages={messages} />)
    
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('Hi there')).toBeInTheDocument()
  })
})
```
