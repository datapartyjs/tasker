const EventEmitter = require('eventemitter3')
debug = require('debug')('Tasker.Task')

/**
 * @typedef Task.Properties
 * @property {string} name Task name
 * @property {bool} background Background task
 * @property {string[]} depends List of task names this task depends upon 
 * @property {Number} created Unix time ms this task was instantiated 
 * @property {Number} started Unix time ms the task began running exec function
 * @property {Number} finished Unix time ms the task completed running exec function
 * @property {bool} done Task has completed?
 * @property {*} success Task success value if one was returned by exec
 * @property {*} failure Task failure value if one was returned by exec
 */



/**
 * Task class
 * @class
 * @extends {Task.Properties}
 */

class Task extends EventEmitter {

  /**
   * Create a task
   * @param {string} options.name Task name
   * @param {} options.depends List of tasks this task depends on
   * @param {} options.exec Function to run. You must either implement `Task.exec` or provide a function here.
   * @param {any} options.context Context data for this task (optional)
   * @param {bool} options.background
   */
  constructor({name, depends, exec, context, background}){
    super()
    this.name = name
    this.background = background || false //! Background tasks don't count against parallel limit
    this.context = context        //! Anything else you need
    this.depends = depends || []  //! Expected to be an array of names
    this._exec = exec
    this._cancel = false

    this.created = Date.now()
    this.started = undefined
    this.finished = undefined
    
    this.done = undefined
    this.success = undefined
    this.failure = undefined

    this._resolve = undefined
    this._reject = undefined
    //this.promise = new Promise((resolve,reject)=>{ this._resolve = resolve; this._reject = reject })



    this._resolveBackground = undefined
    this._rejectBackground = undefined
    this._detached = undefined
    debug(name)
  }

  async reset(){
    if(!this.done){ await this.cancel() }

    this._cancel = false

    this.created = Date.now()
    this.started = undefined
    this.finished = undefined
    
    this.done = undefined
    this.success = undefined
    this.failure = undefined

    this._resolve = undefined
    this._reject = undefined
    //this.promise = new Promise((resolve,reject)=>{ this._resolve = resolve; this._reject = reject })
  
    this._resolveBackground = undefined
    this._rejectBackground = undefined
    this._detached = undefined
  }

  /**
   * @private
   * @fires Task#running
   * @fires Task#pre-failure
   * @fires Task#pre-success
   * @fires Task#failure
   * @fires Task#success
   * @fires Task#done
   * @param {*} dependResults
   * @returns {Object} 
   */
  async run(dependResults){

    debug(this.name,'-',(!this.background? 'running' : 'running ( background )' ))
    try{
      this.started = Date.now()
      /**
       * Running event.
       * 
       * @event Task#running
       * @type {Task}
       */
      this.emit('running', this)
      await this.assertNotCancelled()

      let func = (!this._exec) ? this.exec.bind(this) : this._exec

      let result = func({task:this, depends: dependResults})

      if(this.background){
        await result
      } else {
        this.success = await result
      }
    }
    catch(err){
      debug('done - ',this.name,' - failure')
      this.failure = err
      this.finished = Date.now()
      this.done = true
      
      /**
       * Pre-failure event.
       * 
       * @event Task#pre-failure
       * @type {Task}
       */
      this.emit('pre-failure', this)

      /**
       * Failure event.
       * 
       * @event Task#failure
       * @type {Task}
       */
      this.emit('failure', this)

      /**
       * Done event.
       * 
       * @event Task#done
       * @type {Task}
       */
      this.emit('done', this)
      
      //this._reject(this.failure)
      throw this.failure
    }
    
    debug('done - ',this.name,' - success')
    this.finished = Date.now()
    this.done = true
    
    /**
     * Pre-success event.
     * 
     * @event Task#pre-success
     * @type {Task}
     */
    this.emit('pre-success', this)


    /**
     * Success event.
     * 
     * @event Task#success
     * @type {Task}
     */
    this.emit('success', this)

    this.emit('done', this)
    //this._resolve(this.success)
    return this.success
  }

  /**
   * Begin background task. Only can be used by background tasks.
   * @returns {Promise<any>} A promise which resolves/rejects based on calls to `Task.backgroundResolve` and `Task.backgroundReject`.
   */
  detach(){
    if(!this.background){
      throw new Error('this is not a background task, only background tasks can be datached')
    }

    if(!this._detached){
      this._detached = new Promise((resolve, reject)=>{
        this._rejectBackground = reject
        this._resolveBackground = resolve
      })
    }
    return this._detached
  }

  /**
   * Resolve a background task as a success. This should be used in the stop handler of background tasks.
   * @param {*} value 
   */
  backgroundResolve(value){ this._resolveBackground(value) }

  /**
   * Reject a background task as a failure. This should be used in the stop handler of background tasks.
   * @param {*} value 
   */
  backgroundReject(value){ this._rejectBackground(value) }

  /**
   * Exec function. Background tasks must return `Task.detach()` and manage the task result with the `Task.backgroundResolve()` and `Task.backgroundReject()` functions.
   * @callback TaskExec
   * @param {Task} options.task
   * @param {Collection} options.depends - Collection of task results from dependencies
   * @returns {Promise<any>}
   */

  /**
   * All tasks must either implement this function or provide a `exec` function at construction time. Foreground tasks are expected to do their work and return any data as quickly as possible. Returned data is made available to any tasks that named this task as a depedency. Background tasks are expected to return `this.detach()` and manage their state with the `this.backgroundResolve` and `this.backgroundReject` functions.
   * @type {TaskExec}
   * @param {Task} options.task The task that is running
   * @param {Collection} options.depends - Collection of task results from dependencies
   * @returns {*} Return any data you want dependant tasks to recieve in their `options.depend`
   */
  async exec({task, depends}){
    throw new Error('exec - must override or pass exec function at construction time')
  }

  /**
   * Stop function. Background tasks must manage the task result with the `Task.backgroundResolve()` and `Task.backgroundReject()` functions.
   * @callback TaskStop
   * @returns {Promise<any>}
   */

  /**
   * All background tasks must implement this function. Background tasks must manage the task result with the `Task.backgroundResolve()` and `Task.backgroundReject()` functions.
   * @type {TaskStop}
   */
  async stop(){
    if(this.background){
      throw new Error('exec - must override stop function for background tasks')
    }
  }
  

  /**
   * Cancel task
   * @fires Task#done
   * @fires Task#failure
   */
  async cancel(){
    debug('cancelling -', this.name)
    this._cancel = true
    if(this.started){ 
      await this.stop()
      return
    }

    debug('done - ',this.name,' - failure')
    this.failure = new Error('task cancelled')
    this.finished = Date.now()
    this.emit('done', this)
    this.emit('failure', this)
    this.done = true
  }

  /**
   * Assert not cancelled
   */
  async assertNotCancelled(){
    if(this._cancel){ throw new Error('Task has been cancelled') }
  }

  /**
   * Assert cancelled
   */
  async assertCancelled(){
    if(!this._cancel){ throw new Error('Task has not been cancelled') }
  }
}

module.exports = Task
