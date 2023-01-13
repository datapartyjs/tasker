const Tasker = require('../index')
const Task = Tasker.Task
const TaskRunner = Tasker.Runner

function delayedResolve(value){
  return new Promise((resolve,reject)=>{
    setTimeout(()=>{resolve(value)}, Math.random()*9000)
  })
}

let taskA = new Task({
  name: 'a',
  depends: ['b', 'd'],
  exec: ()=>{return delayedResolve('aA') }
})

let taskB = new Task({
  name: 'b',
  exec: ()=>{ return delayedResolve('bB') }
})

let taskC = new Task({
  name: 'c',
  exec: ()=>{ return delayedResolve('cC') }
})

let taskD = new Task({
  name: 'd',
  depends: ['c'],
  exec: ()=>{ return delayedResolve('dD') }
})

let taskE = new Task({
  name: 'e',
  exec: ()=>{ return delayedResolve('eE') }
})

let runner = new TaskRunner()

runner.addTask(taskA)
runner.addTask(taskB)
runner.addTask(taskC)
runner.addTask(taskD)
runner.addTask(taskE)


let order = runner.runOrder

console.log(order)

let logDone = function(task){
  console.log('\t done task - ', task.name)
}

let logRunning = function(task){
  console.log('\t run task - ', task.name)
}

taskA.on('running', logRunning)
taskB.on('running', logRunning)
taskC.on('running', logRunning)
taskD.on('running', logRunning)
taskE.on('running', logRunning)

taskA.on('done', logDone)
taskB.on('done', logDone)
taskC.on('done', logDone)
taskD.on('done', logDone)
taskE.on('done', logDone)

runner.on('running', ()=>{ console.log('running TaskRunner - ',runner.taskOrder) })
runner.on('idle', ()=>{ console.log('idle TaskRunner - ',runner.taskOrder) })

runner.start().then(console.log).catch(console.log)
