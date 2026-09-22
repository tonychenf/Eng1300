export function Alert({ kind = 'error', children }) {
  if (!children) return null;
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Loading({ label = '加载中' }) {
  return (
    <div className="empty">
      <span className="spinner" /> <span style={{ marginLeft: 8 }}>{label}…</span>
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function PageHead({ title, desc, actions }) {
  return (
    <div className="page-head spread">
      <div>
        <h1>{title}</h1>
        {desc ? <p>{desc}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

const STATUS_KIND = { 已发布: 'ok', 待校对: 'warn', 草稿: 'gray', 存疑: 'danger' };

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_KIND[status] || 'gray'}`}>{status}</span>;
}
