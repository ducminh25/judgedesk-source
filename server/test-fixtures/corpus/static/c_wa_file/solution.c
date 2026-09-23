#include <stdio.h>
int main() { FILE *fin = fopen("input.txt", "r"); FILE *fout = fopen("output.txt", "w"); int a; fscanf(fin, "%d", &a); fprintf(fout, "%d", a + 1); return 0; }
