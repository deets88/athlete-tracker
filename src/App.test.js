import { render, screen } from '@testing-library/react';
import App from './App';

test('renders athlete tracker title', () => {
  render(<App />);
  const titleElement = screen.getByText(/athlete tracker/i);
  expect(titleElement).toBeInTheDocument();
});
