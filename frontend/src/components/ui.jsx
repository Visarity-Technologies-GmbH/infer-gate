import React, { useEffect, useRef } from "react";
export function Icon({ name, size = 20 }) {
  const paths = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    key: "M14 8a5 5 0 1 1-4-5 M10 12l-8 8v2h4v-3h3v-3l3-3",
    server: "M3 3h18v7H3z M3 14h18v7H3z M7 6v1 M7 17v1",
    chart: "M3 3v18h18 M7 16v-5 M12 16V7 M17 16v-8",
    shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6",
    settings:
      "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.5 5.5l2 2 M16.5 16.5l2 2 M5.5 18.5l2-2 M16.5 7.5l2-2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    arrow: "M5 12h14 M14 7l5 5-5 5",
    plus: "M12 5v14 M5 12h14",
    refresh:
      "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 3 M4 16l2 3a7 7 0 0 0 12-2",
    logout: "M9 4H4v16h5 M10 12h11 M17 8l4 4-4 4",
    search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    close: "M6 6l12 12 M6 18L18 6",
    menu: "M4 6h16 M4 12h16 M4 18h16",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.grid} />
    </svg>
  );
}
export const Badge = ({ value }) => (
  <span
    className={`badge ${["ACTIVE", "SUCCESS", "ALLOW"].includes(value) ? "good" : ["FAILED", "REVOKED", "DENY", "REJECTED"].includes(value) ? "bad" : ""}`}
  >
    <i />
    {value || "Unknown"}
  </span>
);
export const ErrorBox = ({ error }) =>
  error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
export function Modal({ title, children, onClose }) {
  const ref = useRef();
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({ label, children, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children || <input {...props} />}
    </label>
  );
}
export function Empty({
  title = "Nothing here yet",
  detail = "Your data will appear here when it becomes available.",
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="grid" size={26} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
export function Table({ columns, rows, empty }) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map(([name]) => (
              <th key={name}>{name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || row.bucket || index}>
              {columns.map(([name, render]) => (
                <td key={name}>{render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty {...empty} />
  );
}
