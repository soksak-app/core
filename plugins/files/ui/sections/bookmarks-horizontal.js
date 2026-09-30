// 가로 북마크는 같은 프로젝트 상태의 모든 경로와 삭제 명령을 가로 목록으로 표시한다.
export function mount(root, context) {
  if(context.orientation !== 'horizontal') throw new Error('horizontal bookmarks require horizontal orientation');
  const list=document.createElement('ul');
  Object.assign(list.style,{display:'flex',alignItems:'center',gap:'12px',height:'100%',overflowX:'auto'});
  root.append(list);
  let drawn;
  const stop=context.status('files.bookmarks',(paths,source)=>{
    const key=JSON.stringify([paths,source]);if(key===drawn)return;drawn=key;
    list.replaceChildren();
    if(source===null){list.textContent='프로젝트 없음';return;}
    if(paths.length===0){list.textContent='북마크 없음';return;}
    for(const path of paths){
      const item=document.createElement('li');Object.assign(item.style,{display:'flex',gap:'6px',alignItems:'center',flex:'0 0 auto'});
      const name=document.createElement('span');name.textContent=path;
      const remove=document.createElement('button');remove.type='button';remove.textContent='삭제';
      item.append(name,context.bind(remove,'files.bookmarks.remove',{path}));list.append(item);
    }
  });
  return {dispose(){stop();list.remove();}};
}
