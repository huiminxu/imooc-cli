const io = require('socket.io-client');
const get = require('lodash/get');
const { parseMsg } = require('./parse');
const log = require('../log');
const getOSSProject = require('./getOSSProject');
const inquirer = require('../inquirer');

const WS_SERVER = 'ws://book.youbaobao.xyz:7002';
const FAILED_CODE = [ 'prepare failed', 'download failed', 'build failed', 'pre-publish failed', 'publish failed' ];

class CloudBuild {
  constructor(git, type, options = {}) {
    this._git = git;
    this._type = type; // 发布类型，目前仅支持oss
    this._options = options;
    this._timeout = get(options, 'timeout') || 600 * 1000; // 默认超时时间10分钟
  }

  timeout = (fn, timeout) => {
    clearTimeout(this.timer);
    log.notice('设置任务超时时间：', `${+timeout / 1000}秒`);
    this.timer = setTimeout(fn, timeout);
  };

  prepare = async () => {
    const projectName = this._git.name;
    const ossProject = await getOSSProject({
      name: projectName,
      type: this._options.prod ? 'prod' : 'dev',
    });
    if (ossProject.code === 0 && ossProject.data.length > 0) {
      const cover = await inquirer({
        type: 'list',
        choices: [ { name: '覆盖发布', value: true }, { name: '放弃发布', value: false } ],
        defaultValue: true,
        message: `OSS已存在 [${projectName}] 项目，是否强行覆盖发布？`
      });
      if (!cover) {
        throw new Error('发布终止');
      }
    }
  };

  init = () => {
    log.notice('开始云构建任务初始化');
    log.verbose(this._git.remote);
    return new Promise((resolve, reject) => {
      const socket = io(WS_SERVER, {
        query: {
          repo: this._git.remote,
          type: this._type,
          name: this._git.name,
          branch: this._git.branch,
          version: this._git.version,
        },
        transports: [ 'websocket' ],
      });
      this.timeout(() => {
        log.error('云构建服务创建超时，自动终止');
        disconnect();
      }, 5000);
      const disconnect = () => {
        clearTimeout(this.timer);
        socket.disconnect();
        socket.close();
      };
      socket.on('connect', () => {
        const id = socket.id;
        log.success('云构建任务创建成功', `任务ID：${id}`);
        this.timeout(() => {
          log.error('云构建服务执行超时，自动终止');
          disconnect();
        }, this._timeout);
        socket.on(id, msg => {
          const parsedMsg = parseMsg(msg);
          log.success(parsedMsg.action, parsedMsg.message);
        });
        resolve();
      });
      socket.on('build', (msg) => {
        const parsedMsg = parseMsg(msg);
        if (FAILED_CODE.indexOf(parsedMsg.action) >= 0) {
          log.error(parsedMsg.action, parsedMsg.message);
          disconnect();
        } else {
          log.success(parsedMsg.action, parsedMsg.message);
        }
      });
      socket.on('building', (msg) => {
        console.log(msg);
      });
      socket.on('disconnect', () => {
        log.success('云构建任务断开');
        disconnect();
      });
      socket.on('error', (err) => {
        log.error('云构建出错', err);
        disconnect();
        reject(err);
      });
      this._socket = socket;
    });
  };

  build = () => {
    this._socket.emit('build');
  };
}

module.exports = CloudBuild;
