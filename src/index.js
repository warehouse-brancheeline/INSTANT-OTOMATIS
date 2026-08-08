const config = require('./config');
const { createServer } = require('./server');
const scheduler = require('./scheduler');

const app = createServer();

app.listen(config.port, () => {
  console.log(`[index] WEB INSTANT dashboard running at http://localhost:${config.port}`);
  scheduler.start();
});
