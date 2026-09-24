// 题目渲染。作答页与成绩报告共用，靠 review 开关切换只读与可作答。

export function optionLetter(opt, index) {
  const m = String(opt).match(/^\s*([A-Z])\s*[.、．)]/);
  return m ? m[1] : String.fromCharCode(65 + index);
}

export function optionText(opt) {
  return String(opt).replace(/^\s*[A-Z]\s*[.、．)]\s*/, '');
}

// 同一部分内所有题共用一组长选项（段落大意、填句补文、填词补文），
// 就把选项库提到部分开头显示一次，每题只留一排字母按钮，免得同样的
// 五到十二条长句在一页里重复十遍。
//
// 阈值取 5：阅读判断只有 True/False/Not Given 三条、阅读理解选择四条且
// 每题各不相同，这两类直接把选项排在题目下面更好读。
const SHARED_MIN_OPTIONS = 5;

export function sharedOptionsOf(section) {
  const qs = section.questions.filter((q) => q.options?.length);
  if (qs.length < 2) return null;
  if (qs[0].options.length < SHARED_MIN_OPTIONS) return null;
  const first = JSON.stringify(qs[0].options);
  return qs.every((q) => JSON.stringify(q.options) === first) ? qs[0].options : null;
}

export function OptionBank({ options }) {
  return (
    <div className="card card-pad" style={{ background: '#fafbfc', marginBottom: 12 }}>
      <div className="tiny muted" style={{ marginBottom: 6 }}>选项库</div>
      <div className="stack" style={{ fontSize: 14 }}>
        {options.map((o, i) => (
          <div key={i}>
            <strong>{optionLetter(o, i)}.</strong> {optionText(o)}
          </div>
        ))}
      </div>
    </div>
  );
}

// 得分单元分两类（§6.4.5）：BLANK / OPTION 是学生逐个填的**输入单元**，
// SCORE_POINT / STEP 是学生写一整段、判分时才拆的**判定单元**。
// 只有输入单元会改变作答控件的形状。
// 一题多空：一空一个输入框，答案存成 {"单元序号":"答案"} 的 JSON。
// 用序号不用数组下标——题目改版加删空之后下标会整体错位，而且不报错。
function parseItemAnswer(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

const INPUT_KINDS = ['BLANK', 'OPTION'];
const inputItemsOf = (q) => (q.items || []).filter((it) => INPUT_KINDS.includes(it.kind));

/**
 * 这道题算不算作答了。
 *
 * 多单元题的作答是一串 JSON，一个空都没填时它长这样：{"1":"","2":""}——
 * 直接判字符串非空的话，一道全空的填空题会被算成"已答"，答题卡显示 51/51，
 * 学生按提示交了卷才发现空着。
 */
export function hasAnswer(q, value) {
  const raw = value ?? '';
  if (!inputItemsOf(q).length) return Boolean(String(raw).trim());
  const obj = parseItemAnswer(String(raw));
  return Object.values(obj).some((v) => String(v ?? '').trim());
}

/**
 * 一道题。
 * review=false 时可作答；review=true 时只读并标出对错。
 */
export function Question({ q, compact, value, onChange, review }) {
  const answered = review ? q.userAnswer : value;
  const blanks = inputItemsOf(q);

  return (
    <div className="q-card">
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <span className="q-num">{q.ord}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {q.questionType === 'fill_text' ? (
            <div className="q-stem">
              给定词：<strong className="mono">{q.stem}</strong>
            </div>
          ) : (
            <div className="q-stem" style={{ whiteSpace: 'pre-wrap' }}>{q.stem}</div>
          )}

          {review ? <Verdict q={q} /> : null}
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        {blanks.length ? (
          <MultiBlank q={q} items={blanks} value={answered} onChange={onChange} review={review} />
        ) : q.questionType === 'essay' ? (
          <Essay q={q} value={answered} onChange={onChange} review={review} />
        ) : q.questionType === 'fill_text' ? (
          <FillBlank q={q} value={answered} onChange={onChange} review={review} />
        ) : compact ? (
          <LetterRow q={q} value={answered} onChange={onChange} review={review} />
        ) : (
          <ChoiceList q={q} value={answered} onChange={onChange} review={review} />
        )}
      </div>

      {review && q.itemResults?.length && !blanks.length ? <ItemBreakdown q={q} /> : null}

      {review && q.explanation ? (
        <details style={{ marginTop: 10 }}>
          <summary className="small muted" style={{ cursor: 'pointer', minHeight: 32 }}>查看解析</summary>
          <div className="passage" style={{ marginTop: 6 }}>{q.explanation}</div>
        </details>
      ) : null}
    </div>
  );
}

function Verdict({ q }) {
  if (q.isCorrect === null || q.isCorrect === undefined) {
    return <span className="badge gray" style={{ marginTop: 6 }}>待批改</span>;
  }
  if (q.isCorrect === 1) return <span className="badge ok" style={{ marginTop: 6 }}>答对 +{q.score}</span>;
  // 部分分（§6.4.5）：答错但拿到分的题，只写"答错"会让学生以为这题 0 分。
  // 学科不给部分分时 scoreRate 只会是 0 或 1，这一支走不到。
  if (q.scoreRate > 0 && q.scoreRate < 1) {
    return (
      <span className="row" style={{ marginTop: 6, gap: 6 }}>
        <span className="badge warn">部分得分 +{q.score}</span>
        <span className="tiny muted">得分率 {Math.round(q.scoreRate * 100)}%</span>
      </span>
    );
  }
  return (
    <span className="row" style={{ marginTop: 6, gap: 6 }}>
      <span className="badge danger">答错</span>
      {q.correctAnswer ? <span className="tiny muted">正确答案 {q.correctAnswer}</span> : null}
    </span>
  );
}

function MultiBlank({ q, items, value, onChange, review }) {
  const current = parseItemAnswer(review ? q.userAnswer : value);
  const resultOf = (ord) => {
    for (const g of q.itemResults || []) {
      const hit = (g.items || []).find((x) => x.ord === ord);
      if (hit) return hit;
    }
    return null;
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map((it) => {
        const r = review ? resultOf(it.ord) : null;
        return (
          <div key={it.ord} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="tiny muted" style={{ minWidth: 40 }}>第 {it.ord} 空</span>
            {review ? (
              <span className="small" style={{ flex: '1 1 200px' }}>
                <strong className="mono">{current[it.ord] || '（未作答）'}</strong>
                {r && r.hit === 1 ? (
                  <span className="badge ok" style={{ marginLeft: 8 }}>对</span>
                ) : (
                  <>
                    <span className="badge danger" style={{ marginLeft: 8 }}>错</span>
                    {it.answer ? (
                      <span className="tiny muted" style={{ marginLeft: 8 }}>
                        正确答案 <strong className="mono">{it.answer}</strong>
                      </span>
                    ) : null}
                  </>
                )}
                {r?.note ? <span className="tiny muted" style={{ marginLeft: 8 }}>（{r.note}）</span> : null}
              </span>
            ) : (
              <input
                className="input" style={{ flex: '1 1 160px' }}
                value={current[it.ord] || ''}
                autoCapitalize="none" autoCorrect="off" spellCheck="false"
                placeholder={`第 ${it.ord} 空`}
                onChange={(e) => onChange(JSON.stringify({ ...current, [it.ord]: e.target.value }))}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// 采分点式判分的逐点结果（名词解释、问答、解答题）。
// 学生要看得见"哪一点没答到"，这正是采分点式判分相对"AI 直接打分"的好处。
function ItemBreakdown({ q }) {
  return (
    <div className="stack" style={{ gap: 4, marginTop: 10 }}>
      <div className="tiny muted">逐点判定</div>
      {(q.itemResults || []).flatMap((g) => (g.items || []).map((it) => {
        const desc = (q.items || []).find((x) => x.ord === it.ord);
        return (
          <div key={`${g.group}-${it.ord}`} className="small">
            <span className={`badge ${it.hit === 1 ? 'ok' : 'danger'}`}>{it.hit === 1 ? '命中' : '未命中'}</span>
            <span style={{ marginLeft: 8 }}>{desc?.answer || `第 ${it.ord} 点`}</span>
            {it.note ? <span className="tiny muted" style={{ marginLeft: 8 }}>（{it.note}）</span> : null}
          </div>
        );
      }))}
    </div>
  );
}

function ChoiceList({ q, value, onChange, review }) {
  return q.options.map((opt, i) => {
    const letter = optionLetter(opt, i);
    const picked = value === letter;
    let cls = 'choice';
    if (review) {
      if (letter === q.correctAnswer) cls += ' right';
      else if (picked) cls += ' wrong';
    } else if (picked) cls += ' picked';
    return (
      <label key={i} className={cls}>
        <input type="radio" name={q.questionId} checked={picked} disabled={review}
          onChange={() => onChange(letter)} />
        <span><span className="key">{letter}.</span> {optionText(opt)}</span>
      </label>
    );
  });
}

// 选项库已在部分开头列过，这里只给一排字母
function LetterRow({ q, value, onChange, review }) {
  return (
    <div className="wordbank">
      {q.options.map((opt, i) => {
        const letter = optionLetter(opt, i);
        const picked = value === letter;
        let style;
        if (review) {
          if (letter === q.correctAnswer) style = { borderColor: 'var(--ok)', background: 'var(--ok-tint)', color: 'var(--ok)' };
          else if (picked) style = { borderColor: 'var(--danger)', background: 'var(--danger-tint)', color: 'var(--danger)' };
        }
        return (
          <button key={i} type="button" disabled={review} style={style}
            className={picked && !review ? 'picked' : undefined}
            onClick={() => onChange(picked ? '' : letter)}>
            {letter}
          </button>
        );
      })}
    </div>
  );
}

function FillBlank({ q, value, onChange, review }) {
  if (review) {
    return (
      <div className="small">
        你的答案：<strong className="mono">{q.userAnswer || '（未作答）'}</strong>
        {q.isCorrect === 1 ? null : (
          <span style={{ marginLeft: 12 }}>正确答案：<strong className="mono">{q.correctAnswer}</strong></span>
        )}
      </div>
    );
  }
  return (
    <input className="input" value={value || ''} autoCapitalize="none" autoCorrect="off" spellCheck="false"
      placeholder="填入正确形式" onChange={(e) => onChange(e.target.value)} />
  );
}

function Essay({ q, value, onChange, review }) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean).length;
  if (review) {
    return (
      <>
        <div className="passage" style={{ background: '#fafbfc', padding: 12, borderRadius: 8 }}>
          {q.userAnswer || '（未作答）'}
        </div>
        <p className="tiny muted">作文评分需要 AI 批改，本期尚未开放，暂不计入总分。</p>
      </>
    );
  }
  return (
    <>
      <textarea className="textarea" style={{ minHeight: 220 }} value={value || ''}
        placeholder="在此写作，约 100 词" onChange={(e) => onChange(e.target.value)} />
      <div className="tiny muted" style={{ textAlign: 'right' }}>{words} 词</div>
    </>
  );
}
