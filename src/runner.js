const Dependency = require('dependency-solver')
const debug = require('debug')('Tasker.Runner')
const verbose = require('debug')('Tasker.Runner.verbose')
const {JSONPath} = require('jsonpath-plus')
const EventEmitter = require('eventemitter3')

/**
 * Class representing a task runner.
 */
class Runner extends EventEmitter {

  /**
   * Create a task runner
   * @param {Number} [options.parallel=10] Number of parallel foreground tasks can be run in parallel
   * @param {Number} [options.restartDelayMs=5000] Number of milliseconds to wait before restarting a task during task resets
   * @param {Number} [options.planningIntervalMs=100] Number of milliseconds between planning watchdog timer
   */

  constructor({parallel=10, restartDelayMs=5000, planningIntervalMs=100}={}){
    super()
    this.holding = {}
    this.pending = {}
    this.running = {}
    this.success = {}
    this.failure = {}
    this.background = {}

    this.parallel = parallel || 10

    this.taskOrder = []

    this.started = false
    this._noWorkCount = 0
    this._runWatchdog = undefined
    this._planningInterval = planningIntervalMs || 100
    this._restartDelay = restartDelayMs || 5000
  }

  /**
   * Start task runner
   * @fires Runner#running
   */
  async start(){
    this.started = true
    if(this._runWatchdog){ return }
    this.runTasks()
    //this._runWatchdog = setTimeout(this.runTasks.bind(this), this._planningInterval)

    /**
     * Running event.
     * 
     * @event Runner#running
     */
    this.emit('running')
  }

  /**
   * Stop running tasks. Calls Task.cancel on all running and pending tasks. Then resets all tasks.
   */
  async stop(){
    debug('stopping')
    this.printTaskLists()
    this.started = false
    clearTimeout(this._runWatchdog)
    this._runWatchdog = undefined

    const taskList = this.tasks
    if(taskList && this.hasWork()){
      debug('cancelling incomplete tasks')
      const nameList = Object.keys(taskList)
      for(let name of nameList){
        
        if(!this.isDone(name)){
          let task = taskList[name]
          task.off('pre-success', this.onPreSuccess.bind(this))
          task.off('pre-failure', this.onPreFailure.bind(this))
          await task.cancel()
        }
      }
    }

    if(taskList){
      Object.keys(taskList).map(name=>{
        this.resetTask(name)
      })
    }
    

    this.holding = {}
    this.pending = {}
    this.running = {}
    this.success = {}
    this.failure = {}
    this.background = {}
    this.taskOrder = []
    this.started = false
    this._noWorkCount = 0
  }

  /**
   * A collection mapping task names to Task instances.
   */
  get tasks(){
    return   Object.assign(
      {},
      this.holding,
      this.pending,
      this.running,
      this.background,
      this.success,
      this.failure
    )
  }

  /** An array of tasks in the order initially added. */
  get depends(){
    //let graph = {}
    const taskMap = this.tasks
    let taskList = []

    for(let taskName in taskMap){
      const task = taskMap[taskName]
      taskList.push( task )

      //verbose(taskName)

      //graph[taskName+''] = task.depends
    }

    //verbose(JSON.stringify(taskList))
    return taskList
  }

  /** List of task names in dependency resolved order */
  get runOrder(){
    const depends = this.depends
    let taskOrder = []

    const tasksWithDepends = JSONPath(
      '$.graph[?(@.depends.length >0)].name',
      {graph: depends}
    )

    const tasksWithoutDepends = JSONPath(
      '$.graph[?(@.depends.length ==0)].name',
      {graph: depends}
    )

    taskOrder = taskOrder.concat(tasksWithoutDepends)

    //verbose('depends', JSON.stringify(tasksWithDepends))
    //verbose('no depends', JSON.stringify(tasksWithoutDepends))
    //verbose('taskOrder-prelim', taskOrder)
    
    if(tasksWithDepends && tasksWithDepends.length > 0){
      const graph = {}
      tasksWithDepends.map((taskName)=>{
        const task = this.tasks[taskName]
        graph[taskName]=task.depends
      })

      const solved = Dependency.solve(graph)
      //verbose('solved', solved)

      for(let taskName of solved){
        if(taskOrder.indexOf(taskName) < 0 ){
          taskOrder.push( taskName )
        }
      }
    }

    verbose('taskOrder', taskOrder)
    this.taskOrder = taskOrder
    return taskOrder
  }

  /**
   * Get collection of task results
   * @param {string[]} nameList List of task results to lookup
   * @returns {any}
   */
  collectResults(nameList){
    const taskList = this.tasks
    let results = {}

    nameList.map((taskName)=>{ results[taskName] = taskList[taskName] })
    return results
  }

  /**
   * Execute tasks
   * @fires Runner#idle 
   */
  runTasks(){
    verbose('runTasks')

    if(!this.hasWork()){
      verbose('no work')
      this._noWorkCount++

      if(this._noWorkCount >= 2){
        clearTimeout(this._runWatchdog)
        this.runningCount = undefined

        /**
         * Idle event.
         * 
         * @event Runner#idle
         */
        this.emit('idle')
        return
      }
    } else {
      this._noWorkCount = 0
    }

    const order = this.runOrder
    const taskList = this.tasks
    let runningCount = Object.keys(this.running).length

    verbose('Running ',runningCount,'out of',this.parallel)
    if(runningCount >= this.parallel){ 
      if(this.started){
        this._runWatchdog = setTimeout(this.runTasks.bind(this), this._planningInterval)
      }
      return
    }

    for(let taskName of order){
      verbose('review task', taskName)
      let task = taskList[taskName]
      runningCount = Object.keys(this.running).length

      try{
        if(this.canRun(task)){
          verbose('\t\tcanRun - true')
  
          switch(this.taskState(taskName)){
            case 'holding':
              this.setTaskState(taskName, 'pending')
              break;
            case 'pending':
              if(runningCount >= this.parallel) { continue }
              if(! this.allDone(task.depends)) { continue }
              this.setTaskState(taskName, (!task.background ? 'running': 'background'))
              task.once('pre-success', this.onPreSuccess.bind(this))
              task.once('pre-failure', this.onPreFailure.bind(this))
              task.run(this.collectResults(task.depends)).catch(err=>{
                debug('error while running task -', taskName)
                this.printTaskLists()
                return Promise.resolve()
              })
              break;
            default:
              break
          }
        }
        else{
          verbose('\t\tcanRun == FALSE')
        }
      } catch (err) {
        debug('failed to run task -', taskName, 'error -', err)
      }
    }


    runningCount = Object.keys(this.running).length
    verbose('Running ',runningCount,'out of',this.parallel)

    //this.printTaskLists()
    if(this.started){
      this._runWatchdog = setTimeout(this.runTasks.bind(this), this._planningInterval)
    }
  }

  /**
   * Print task list for debugging. Must enable debugging
   * @private
   */
  printTaskLists(){
    let queues = ['holding','pending','running', 'background', 'success','failure']

    for(let queueName of queues){
      let queue = this[queueName]
      if(!queue){
        debug('queue - ', queueName, null)
        continue
      }
      debug('queue - ', queueName, 'length', Object.keys(queue).length)

      for(let taskName in queue){
        let task = queue[taskName]
        debug('\t\ttask - ', taskName, task.failure)
      }
    }
    debug(this.taskOrder)
  }

  /**
   * @fires Runner#task-done
   * @fires Runner#task-success
   * @private 
   */
  onPreSuccess(task){
    verbose('Success - ', task.name)
    task.off('pre-success', this.onPreSuccess.bind(this))
    task.off('pre-failure', this.onPreFailure.bind(this))
    this.setTaskState(task.name, 'success')

    /**
     * Task done event.
     * 
     * @event Runner#task-done
     * @type {Task}
     */
    this.emit('task-done', task)

    /**
     * Task success event.
     * 
     * @event Runner#task-success
     * @type {Task}
     */
    this.emit('task-success', task)
  }

  /**
   * @fires Runner#task-done
   * @fires Runner#task-failure
   * @private 
   */
  onPreFailure(task){
    verbose('Failure - ', task.name, task.failure)
    task.off('pre-success', this.onPreSuccess.bind(this))
    task.off('pre-failure', this.onPreFailure.bind(this))
    this.setTaskState(task.name, 'failure')

    this.emit('task-done', task)

    /**
     * Task failure event.
     * 
     * @event Runner#task-failure
     * @type {Task}
     */
    this.emit('task-failure', task)

    if(task.background && !task._cancel){
      this.restartTask(task.name)
    }
  }

  /**
   * Call the reset function on the named task and reschedule task.
   * @param {string} taskName 
   * @param {Number} timeout Timeout ms. Defaults to restartDelayMs provided in constructor
   */
  restartTask(taskName, timeout){
    debug('restarting task - ', taskName, 'in', timeout||this._restartDelay, 'ms')
      setTimeout(async ()=>{
        let task = this.getTask(taskName)
        
        if(!task){return}
        await task.reset()
        this.setTaskState(taskName)
        this.addTask(task)
        if(this.started && this._runWatchdog == undefined){ this.start() }
      }, timeout||this._restartDelay)
  }
  
  /**
   * Call the reset function on the named task
   * @param {string} taskName 
   * @param {Number} timeout Timeout ms. Defaults to restartDelayMs provided in constructor
   */
  resetTask(taskName, timeout){
    debug('resetting task - ', taskName, 'in', timeout||this._restartDelay, 'ms')
      setTimeout(async ()=>{
        let task = this.getTask(taskName)
        
        if(!task){return}
        await task.reset()
        this.setTaskState(taskName)
      }, timeout||this._restartDelay)
  }
  

  /**
   * Check if the there are pending or running tasks
   * @returns bool
   */
  hasWork(){
    const queueList = ['holding', 'pending', 'running', 'background']

    for(let queueName of queueList){
      const queue = this[queueName]
      if(Object.keys(queue).length > 0 ){ 
        verbose('hasWork == true - ', queueName)
        return true
      }
    }

    verbose('hasWork == false')
    return false
  }

  /**
   * Check if the task list is running
   * @param {string} taskName 
   * @returns bool
   */
  isRunning(taskName){
    let state = this.taskState(taskName)
    return 'running' === state || 'background' === state
  }

  /**
   * Check if the task list is pending
   * @param {string} taskName 
   * @returns bool
   */
  isPending(taskName){
    let state = this.taskState(name)
    return 'pending' === state || 'holding' === state
  }

  /**
   * Check if the task list is done
   * @param {string} taskName 
   * @returns bool
   */
  isDone(taskName){
    let state = this.taskState(taskName)
    return (['success', 'failure'].indexOf(state) > -1)
  }

  /**
   * Check if the entire task list is complete
   * @param {string[]} taskList 
   * @returns bool
   */
  allDone(taskList){
    for(let taskName of taskList){
      if(!this.isDone(taskName)){
        verbose('not done', taskName)
        return false
      }
    }

    return true
  }

/**
 * @typedef {'holding' |'pending' |'running' | 'background' | 'success' |'failure'} TaskState
 */

  /**
   * Lookup task state.
   * @param {string} name Task name 
   * @returns {TaskState} 
   */
  taskState(name){
    let queueNames = ['holding','pending','running', 'background', 'success','failure']

    for(let queueName of queueNames){
      let queue = this[queueName]
      if(!queue){continue}
      for(let taskName of Object.keys(queue)){
        if(taskName == name){
          return queueName
        }
      }
    }

    throw new Error('findTask - Task ['+name+'] not found')
  }

  /**
   * Change task state
   * 
   * @param {string} taskName
   * @param {string} state  New task state
   * @private 
   */
  setTaskState(taskName, state){
    if(['holding','pending','running','background','success','failure', undefined].indexOf(state) < 0){
      throw new Error('setTaskState - Invalid state['+state+']')
    }

    let currentState = this.taskState(taskName)
    if(currentState == state ){ return }

    let currentQueue = this[ currentState ]
    let task = currentQueue[taskName]

    
    currentQueue[taskName] = undefined
    delete currentQueue[taskName]

    if(!state){ return }

    this[state][taskName] = task
    verbose('setTaskState - task ['+task.name+'] is '+state)
  }

  /**
   * Can the task be run
   * @param {Tasker.Task} task 
   * @returns bool
   */
  canRun(task){
    try{
      let ready = this.allDone(task.depends)
    }
    catch(err){
      verbose('false due to error ', task)
      return false
    }
    return true
  }

  /**
   * Does task exist in runner?
   * @param {string} taskName 
   * @returns bool
   */
  exists(taskName){
    return this.tasks[taskName] !== undefined
  }

  /**
   * Add task to run queue
   * @param {Tasker.Task} task 
   * @returns {Tasker.Task}
   */
  async addTask(task){

    if(this.exists(task.name)){
      throw new Error('duplicate task name ['+task.name+']')
    }

    if(this.canRun(task)){
      debug('addTask - task ['+task.name+'] is pending')
      this.pending[task.name] = task

    } else {

      debug('addTask - task ['+task.name+'] is holding')
      this.holding[task.name] = task
    }

    if(this.started && this._runWatchdog == undefined){ this.start() }

    //return task.promise
    return task
  }

  /**
   * Lookup task instance
   * @param {string} taskName 
   * @returns {Tasker.Task}
   */
  getTask(taskName){
    return this.tasks[taskName]
  }

  /**
   * Cancel task, returns the result of the Tasker.Task.cancel() function.
   * @param {string} taskName 
   * @returns {Promise<any>}
   */
  async cancelTask(taskName){
    let task = await this.tasks[taskName]
    return task.cancel()
  }

}

module.exports = Runner