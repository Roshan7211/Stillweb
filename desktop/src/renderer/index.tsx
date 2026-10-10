import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

/**
 * If drawing the interface ever fails, the bars must not stay blank: the interface starts
 * again, and if that fails too it says so and offers to try once more.
 */
class Recover extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('The interface stopped:', error);
    // Once: a fault that comes straight back must not reload forever.
    const before = Number(sessionStorage.getItem('restarts') ?? '0');
    if (before < 1) {
      sessionStorage.setItem('restarts', String(before + 1));
      location.reload();
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="recover">
        <span>Something went wrong in Stillweb’s toolbar. Your tabs are still open.</span>
        <button
          className="button"
          onClick={() => {
            sessionStorage.removeItem('restarts');
            location.reload();
          }}>
          Reload the toolbar
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <Recover>
    <App />
  </Recover>,
);
