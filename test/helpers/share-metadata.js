function fixture({ id = '123456789', role = 0, share = 'a'.repeat(64) } = {}) {
  const values = [];
  function encode(value) {
    const index = values.length; values.push(null);
    if (value && typeof value === 'object') {
      const object = {};
      for (const [key, child] of Object.entries(value)) object[`_${encode(key)}`] = encode(child);
      values[index] = object;
    } else values[index] = value;
    return index;
  }
  encode({ loaderData: { 'routes/_index': { initData: { shareId: share,
    knowledgeBaseInfo: { id, basicInfo: { title: 'Synthetic library' },
      userPermissionInfo: { roleType: role, isInApplyList: false } } } } } });
  return `<script>window.__remixContext.streamController.enqueue(${JSON.stringify(JSON.stringify(values))});</script>`;
}
module.exports = { fixture };
