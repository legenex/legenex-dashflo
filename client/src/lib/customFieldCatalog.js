export function customFieldCatalog(fields) {
  const defined = Array.isArray(fields) ? fields : [];
  return {
    defined,
    autoDetected: defined.filter((field) => field?.auto_created === true),
  };
}

export default customFieldCatalog;
