import React, { Component, ReactNode } from 'react';
import { RefreshCcw, AlertTriangle } from 'lucide-react';

interface Props {
    children: ReactNode;
    variant?: 'fullscreen' | 'inline';
    resetKey?: string | number;
    label?: string;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('ErrorBoundary caught:', error, errorInfo);
    }

    componentDidUpdate(prevProps: Props) {
        // Reset state when the resetKey changes (e.g., user navigates to a different page)
        if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
            this.setState({ hasError: false, error: null });
        }
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    handleReload = () => {
        this.setState({ hasError: false, error: null });
        window.location.reload();
    };

    render() {
        if (!this.state.hasError) return this.props.children;

        const variant = this.props.variant || 'fullscreen';
        const label = this.props.label || 'this page';

        if (variant === 'inline') {
            return (
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-red-200 dark:border-red-900/50 shadow-sm p-8 text-center">
                    <div className="w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                        <AlertTriangle className="w-6 h-6 text-red-600" />
                    </div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">Couldn't load {label}</h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        An error occurred while rendering this page. Other pages should still work.
                    </p>
                    <p className="text-[11px] text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-lg p-3 mb-4 font-mono text-left break-all max-w-md mx-auto">
                        {this.state.error?.message || 'Unknown error'}
                    </p>
                    <div className="flex items-center justify-center gap-2">
                        <button
                            onClick={this.handleReset}
                            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-blue-700 transition inline-flex items-center gap-2"
                        >
                            <RefreshCcw className="w-3 h-3" />
                            Retry
                        </button>
                        <button
                            onClick={this.handleReload}
                            className="border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300 px-4 py-2 rounded-lg text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                        >
                            Reload App
                        </button>
                    </div>
                </div>
            );
        }

        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-6">
                <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 p-10 max-w-md w-full text-center">
                    <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
                        <AlertTriangle className="w-8 h-8 text-red-600" />
                    </div>
                    <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-2">Something went wrong</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                        An unexpected error occurred. This has been logged automatically.
                    </p>
                    <p className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-lg p-3 mb-6 font-mono text-left break-all">
                        {this.state.error?.message || 'Unknown error'}
                    </p>
                    <button
                        onClick={this.handleReload}
                        className="bg-blue-600 text-white px-6 py-3 rounded-lg text-sm font-bold hover:bg-blue-700 transition inline-flex items-center space-x-2"
                    >
                        <RefreshCcw className="w-4 h-4" />
                        <span>Reload Application</span>
                    </button>
                </div>
            </div>
        );
    }
}
