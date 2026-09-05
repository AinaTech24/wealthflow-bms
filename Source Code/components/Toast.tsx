import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { CheckCircle, X, AlertTriangle, Info, AlertCircle, ShieldAlert } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
    id: number;
    message: string;
    type: ToastType;
}

interface ConfirmOptions {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'info';
}

interface ToastContextType {
    showToast: (message: string, type?: ToastType) => void;
    showConfirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ToastContext = createContext<ToastContextType>({ showToast: () => { }, showConfirm: () => Promise.resolve(false) });

export const useToast = () => useContext(ToastContext);

let toastIdCounter = 0;

const ToastIcon = ({ type }: { type: ToastType }) => {
    switch (type) {
        case 'success': return <CheckCircle className="w-5 h-5 text-emerald-500 shrink-0" />;
        case 'error': return <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />;
        case 'warning': return <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />;
        case 'info': return <Info className="w-5 h-5 text-blue-500 shrink-0" />;
    }
};

const toastStyles: Record<ToastType, string> = {
    success: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    error: 'bg-red-50 border-red-200 text-red-900',
    warning: 'bg-amber-50 border-amber-200 text-amber-900',
    info: 'bg-blue-50 border-blue-200 text-blue-900',
};

const confirmVariantStyles: Record<string, { icon: string; btn: string; iconColor: string }> = {
    danger: { icon: 'bg-red-100', btn: 'bg-red-600 hover:bg-red-700 shadow-red-100', iconColor: 'text-red-600' },
    warning: { icon: 'bg-amber-100', btn: 'bg-amber-600 hover:bg-amber-700 shadow-amber-100', iconColor: 'text-amber-600' },
    info: { icon: 'bg-blue-100', btn: 'bg-blue-600 hover:bg-blue-700 shadow-blue-100', iconColor: 'text-blue-600' },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const [confirmState, setConfirmState] = useState<{
        options: ConfirmOptions;
        resolve: (value: boolean) => void;
    } | null>(null);

    const showToast = useCallback((message: string, type: ToastType = 'success') => {
        const id = ++toastIdCounter;
        setToasts(prev => [...prev, { id, message, type }]);
    }, []);

    const removeToast = useCallback((id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const showConfirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            setConfirmState({ options, resolve });
        });
    }, []);

    const handleConfirmResponse = (accepted: boolean) => {
        if (confirmState) {
            confirmState.resolve(accepted);
            setConfirmState(null);
        }
    };

    return (
        <ToastContext.Provider value={{ showToast, showConfirm }}>
            {children}

            {/* Toast Notifications */}
            <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none max-w-sm w-full">
                {toasts.map(toast => (
                    <ToastNotification key={toast.id} toast={toast} onRemove={removeToast} />
                ))}
            </div>

            {/* Confirm Dialog */}
            {confirmState && (
                <ConfirmDialog
                    options={confirmState.options}
                    onConfirm={() => handleConfirmResponse(true)}
                    onCancel={() => handleConfirmResponse(false)}
                />
            )}
        </ToastContext.Provider>
    );
};

const ToastNotification: React.FC<{ toast: ToastItem; onRemove: (id: number) => void }> = ({ toast, onRemove }) => {
    useEffect(() => {
        const timer = setTimeout(() => onRemove(toast.id), 3500);
        return () => clearTimeout(timer);
    }, [toast.id, onRemove]);

    return (
        <div
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg animate-in slide-in-from-right-5 fade-in duration-300 ${toastStyles[toast.type]}`}
        >
            <ToastIcon type={toast.type} />
            <p className="text-sm font-medium flex-1">{toast.message}</p>
            <button onClick={() => onRemove(toast.id)} className="opacity-50 hover:opacity-100 transition shrink-0">
                <X className="w-4 h-4" />
            </button>
        </div>
    );
};

const ConfirmDialog: React.FC<{
    options: ConfirmOptions;
    onConfirm: () => void;
    onCancel: () => void;
}> = ({ options, onConfirm, onCancel }) => {
    const confirmBtnRef = useRef<HTMLButtonElement>(null);
    const variant = options.variant || 'warning';
    const styles = confirmVariantStyles[variant];

    useEffect(() => {
        confirmBtnRef.current?.focus();
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onCancel]);

    return (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="p-6">
                    <div className="flex items-start gap-4">
                        <div className={`rounded-full p-3 ${styles.icon} shrink-0`}>
                            <ShieldAlert className={`w-6 h-6 ${styles.iconColor}`} />
                        </div>
                        <div className="flex-1 pt-1">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                                {options.title || 'Confirm Action'}
                            </h3>
                            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                                {options.message}
                            </p>
                        </div>
                    </div>
                </div>
                <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-100 dark:border-slate-700 flex justify-end gap-3">
                    <button
                        onClick={onCancel}
                        className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
                    >
                        {options.cancelText || 'Cancel'}
                    </button>
                    <button
                        ref={confirmBtnRef}
                        onClick={onConfirm}
                        className={`px-5 py-2.5 rounded-xl text-sm font-bold text-white shadow-lg transition ${styles.btn}`}
                    >
                        {options.confirmText || 'Confirm'}
                    </button>
                </div>
            </div>
        </div>
    );
};
