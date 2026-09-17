// Автопубликация запланированных черновиков блога — см. routes/blog-cms.js
// (checkAndPublishDueDrafts). Черновик с датой публикации в прошлом или
// сегодня публикуется сам: карточки, sitemap, feed — синхронизируются
// точно так же, как при ручной публикации из админки.
const { checkAndPublishDueDrafts } = require('../routes/blog-cms');

async function runBlogAutoPublish() {
  try {
    await checkAndPublishDueDrafts();
  } catch (err) {
    console.error('runBlogAutoPublish:', err);
  }
}

module.exports = { runBlogAutoPublish };
