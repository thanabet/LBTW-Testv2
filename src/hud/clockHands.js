export function calcHandAngles(now){
  const hours = now.getHours() % 12;
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();

  const hourDeg = (hours * 30) + (minutes * 0.5);         // 360/12 + minute influence
  const minDeg  = (minutes * 6) + (seconds * 0.1);        // 360/60 + second influence
  return { hourDeg, minDeg };
}
