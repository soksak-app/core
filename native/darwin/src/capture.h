// 창 녹화. 프레임은 지정한 디렉터리에 frame-NNNN.bgra 파일로 기록한다.
void sp_capture_open(long windowNumber);
void sp_capture_start(const char *directory);
int sp_capture_wait(void);
int sp_capture_stop(void);
