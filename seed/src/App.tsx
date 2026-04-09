import { Component, type ErrorInfo, type ReactNode } from 'react';
import { InteractionReviewPanel } from './components/InteractionReviewPanel';
import './App.css';

// Tiny error boundary so the placeholder's "not implemented" throw doesn't
// crash the whole demo page during development. The harness's job is to make
// the boundary stop catching anything.
class DemoErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[demo] component threw:', error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="demo-error">
          <h2>Component not yet implemented</h2>
          <p>The harness will replace the placeholder with a real implementation.</p>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <main className="demo">
      <header>
        <h1>InteractionReviewPanel — Demo</h1>
        <p>
          This is the seed target. The harness consumes Issue #1 and replaces the placeholder
          component with a real implementation.
        </p>
      </header>

      <section className="demo-mount">
        <DemoErrorBoundary>
          <InteractionReviewPanel />
        </DemoErrorBoundary>
      </section>
    </main>
  );
}

export default App;
