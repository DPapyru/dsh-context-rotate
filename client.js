window.__ModuleLoader__.load({
  id: '@local/dsh-context-rotate',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const FIELD_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0' }
    const INPUT_STYLE = {
      width: 96,
      padding: '4px 8px',
      borderRadius: 6,
      border: '1px solid rgba(127,127,127,.35)',
      background: 'transparent',
      color: 'inherit',
    }

    function makeSection(form) {
      return function ContextRotateSection() {
        const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
        React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [])
        const value = snapshot.value ?? {}

        // Numbers stay local while focused: a Host round-trip per keystroke both
        // lags the spinner and overwrites what the user is typing.
        function NumberField(props) {
          const committed = value[props.field] ?? props.fallback
          const [draft, setDraft] = React.useState(String(committed))
          const [editing, setEditing] = React.useState(false)
          React.useEffect(() => {
            if (!editing) setDraft(String(committed))
          }, [committed, editing])
          const commit = () => {
            const next = Number(draft)
            if (Number.isFinite(next) && next >= props.min && next <= props.max) form.set(props.field, next)
            else setDraft(String(committed))
            setEditing(false)
          }
          return h('input', {
            type: 'number',
            min: props.min,
            max: props.max,
            value: draft,
            style: INPUT_STYLE,
            disabled: !snapshot.writable,
            onFocus: () => setEditing(true),
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                commit()
                event.currentTarget.blur()
              }
            },
          })
        }

        const number = (field, fallback, min, max) =>
          h(NumberField, { field, fallback, min, max })

        const toggle = (field, fallback) =>
          h('input', {
            type: 'checkbox',
            checked: value[field] ?? fallback,
            disabled: !snapshot.writable,
            onChange: (event) => form.set(field, event.target.checked),
          })

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', maxWidth: 560 } },
          h(
            'p',
            { style: { opacity: 0.7, fontSize: 13, margin: '0 0 8px' } },
            '上下文占用越过阈值时，把模型可见的对话面截断并重播种一份交接书。界面上的旧消息仍然保留，模型不再看到它们。',
          ),
          h('div', { style: FIELD_STYLE }, h('span', null, '启用自动轮换（/rotate 不受影响）'), toggle('enabled', false)),
          h('div', { style: FIELD_STYLE }, h('span', null, '只预演（写日志、不截断）'), toggle('dryRun', true)),
          h('div', { style: FIELD_STYLE }, h('span', null, '主 agent 阈值（窗口百分比）'), number('mainPercent', 60, 10, 99)),
          h('div', { style: FIELD_STYLE }, h('span', null, '子 agent 阈值（窗口百分比）'), number('subPercent', 50, 10, 99)),
          snapshot.status === 'unavailable'
            ? h('p', { style: { opacity: 0.6, fontSize: 12 } }, '宿主没有提供该命名空间的设置。')
            : null,
        )
      }
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.configForms.whileServed(['context-rotate', 'include:context-rotate'], (served) => {
              const namespace = served.has('context-rotate') ? 'context-rotate' : 'include:context-rotate'
              const form = ctx.configForms.get(namespace)
              return ctx.slots.register(
                { name: 'settings.section', id: 'context-rotate', order: 30, label: () => '上下文轮换' },
                makeSection(form),
              )
            }),
          'context-rotate: settings section',
        )
      },
    }
  },
})
